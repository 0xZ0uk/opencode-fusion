/**
 * TUI half of Fusion.
 *
 * `/fusion` walks lead model → lead effort → sidekick model → sidekick effort
 * through the models OpenCode actually has available at this location, saves
 * the pair through the server plugin, and moves the live session onto the lead.
 * A `prompt.footer.status` slot shows the pair on lead sessions and whether a
 * sidekick handoff is running.
 *
 * Effort is OpenCode's own model `variant` (undefined = model default) — the
 * same knob the built-in variant cycle uses.
 */
import type { Plugin } from "@opencode/plugin/tui"
import type { ModelInfo } from "@opencode/client"
import { Fusion, fusionClient, type PairStatus } from "./rpc.ts"
import { LEAD_AGENT, SIDEKICK_AGENT, describeModelRef, toHostModel, type FusionPair, type ModelRef } from "./pair.ts"
import { savingsReport, type SessionReader } from "./savings.ts"
import { createModelPricing } from "./model-pricing.ts"
import { createPairing, type Catalogue, type Dialogs, type WizardModel } from "./pairing.ts"
import { sidekickSessions, type SidekickSession } from "./sidekick-state.ts"
import { versionWarning } from "./version.ts"
import { claimStatus } from "./status.tsx"
import { claimKeymap } from "./keymap.tsx"

/** The host's model, mapped to the structural shape the wizard seam reads. */
const toWizardModel = (model: ModelInfo): WizardModel => ({
  providerID: model.providerID,
  modelID: model.modelID,
  name: model.name,
  cost: model.cost,
  limit: model.limit,
  variants: model.variants,
})

const plugin: Plugin.Definition = {
  id: "opencode-fusion.tui",
  async setup(context) {
    const fusion = fusionClient(context.client.rpc(Fusion))

    const warning = versionWarning(context.app?.version)
    if (warning) context.ui.toast.show({ title: "Fusion", message: warning, variant: "warning" })

    // Reactive status-slot state: the pair, the lead agent id, and a revision
    // counter for the host's session list.
    //
    // `context.data.session.*` is not a reactive read — the TUI context annotates
    // the reads that are, and those are only the `ui.*` ones — so the sidekick
    // state the slot renders is derived during render and re-derived when a
    // session event bumps `sessionsVersion`. The derivation itself is pure and
    // lives in sidekick-state.ts.
    const [state, setState] = context.storage.memory("fusion-status", {
      initial: {
        pair: undefined as FusionPair | undefined,
        leadAgent: LEAD_AGENT,
        sessionsVersion: 0,
      },
    })

    /**
     * The host's sessions, in the shape the sidekick-state derivation reads.
     *
     * Run status is merged in here rather than read off the session: the host's
     * `SessionInfo` has no status field, it is a separate synchronous
     * `data.session.status(id)` call. `SidekickSession.status` is required, so
     * dropping this line stops the build instead of silently pinning the status
     * line to "not running".
     */
    const sessionSnapshot = (): SidekickSession[] =>
      context.data.session.list().map((session) => ({
        id: session.id,
        metadata: session.metadata,
        time: session.time,
        status: context.data.session.status(session.id),
      }))

    /**
     * Session events that can change which sidekicks a lead has, or whether one
     * runs. Names verified against the host's event types: session.created
     * (SessionCreated), session.deleted (SessionDeleted), session.metadata.updated
     * (SessionMetadataUpdated), session.status (SessionStatusUpdated) and
     * session.idle (SessionIdle).
     */
    const SESSION_EVENTS = [
      "session.created",
      "session.deleted",
      "session.metadata.updated",
      "session.status",
      "session.idle",
    ] as const
    const bumpSessions = () =>
      setState((draft) => {
        draft.sessionsVersion += 1
      })
    const offSessions = SESSION_EVENTS.map((type) => context.data.on(type, bumpSessions))

    const catalogue = async (): Promise<ModelInfo[]> => {
      const location = context.location ?? context.data.location.default()
      try {
        await context.data.location.model.sync(location)
      } catch (error) {
        console.warn(`[fusion] model sync failed: ${String(error)}`)
      }
      const list = context.data.location.model.list(location) ?? []
      const available = list.filter((model) => model.enabled !== false)
      return available.length > 0 ? available : list
    }

    const leadPricing = createModelPricing(catalogue)

    const loadPair = async (): Promise<PairStatus> => {
      try {
        return await fusion.getPair()
      } catch (error) {
        console.warn(`[fusion] server plugin unreachable: ${String(error)}`)
        return { configured: false, leadAgent: LEAD_AGENT, sidekickAgent: SIDEKICK_AGENT }
      }
    }

    const applyStatus = (status: PairStatus) =>
      setState((draft) => {
        draft.pair = status.pair
        draft.leadAgent = status.leadAgent
      })

    void loadPair().then(applyStatus, () => {})

    const offPair = fusion.events.on("pairChanged", () => {
      void loadPair().then(applyStatus, () => {})
    })

    const disposeStatus = claimStatus(context, { state, sessions: sessionSnapshot })

    // The dialogs and the catalogue, adapted to the wizard's structural seams.
    const dialogs: Dialogs = {
      select: async (input) => context.ui.dialog.select(input),
      alert: async (input) => {
        await context.ui.dialog.alert(input)
      },
      toast: (input) => context.ui.toast.show(input),
    }
    const wizardCatalogue: Catalogue = {
      models: async () => (await catalogue()).map(toWizardModel),
    }
    const pickPair = createPairing({ dialogs, catalogue: wizardCatalogue })

    const pairUp = async (): Promise<void> => {
      const current = await loadPair()
      const picked = await pickPair(current.pair)
      // Undefined means the user backed out at some step; nothing to save.
      if (!picked) return
      const next = picked.pair

      try {
        await fusion.setPair(next)
      } catch (error) {
        context.ui.toast.show({ message: `Fusion: failed to save the pair — ${String(error)}`, variant: "error" })
        return
      }
      void loadPair().then(applyStatus, () => {})

      // Follow the lead: move the live session onto the lead agent and the
      // picked lead model now.
      const route = context.ui.router.current()
      if (route.type === "session") {
        try {
          await context.client.session.switchAgent({ sessionID: route.sessionID, agent: current.leadAgent })
        } catch (error) {
          console.warn(`[fusion] could not switch the live session agent: ${String(error)}`)
        }
        try {
          await context.client.session.switchModel({
            sessionID: route.sessionID,
            model: toHostModel(next.lead),
          })
        } catch (error) {
          console.warn(`[fusion] could not switch the live session model: ${String(error)}`)
        }
      }

      // The wizard returns notes rather than toasting them, so the success
      // toast stays one message composed here.
      context.ui.toast.show({
        title: "Fusion paired",
        message:
          `lead ${describeModelRef(next.lead)} · sidekick ${describeModelRef(next.sidekick)}` +
          (picked.warnings.length > 0 ? ` · ${picked.warnings.join(" · ")}` : ""),
        variant: "success",
      })
    }

    /**
     * Per-session savings: the current lead session's billed cost, then every
     * sidekick session ever created for it (older ones survive `reset: true`
     * via the server's history) priced per message at lead rates.
     */
    const showStats = async (): Promise<void> => {
      const fail = (message: string) => context.ui.dialog.alert({ title: "Fusion savings", message })
      try {
        const route = context.ui.router.current()
        if (route.type !== "session") {
          await fail("open a Fusion lead session first")
          return
        }
        const sessionID = route.sessionID
        const reader: SessionReader = {
          sessionID,
          getSession: (id) => context.client.session.get({ sessionID: id }),
          sidekickSessions: async () => sidekickSessions(sessionSnapshot(), sessionID),
          listAssistantMessages: (id, cursor) =>
            context.client.message.list({ sessionID: id, type: "assistant", limit: 100, cursor }),
          leadPricing,
        }
        const lines = await savingsReport((await loadPair()).pair, reader)
        await context.ui.dialog.alert({ title: "Fusion savings", message: lines.join("\n") })
      } catch (error) {
        await fail(`unavailable: ${String(error)}`)
      }
    }

    const showPairing = async (): Promise<void> => {
      const status = await loadPair()
      const selected = context.ui.model.current()
      const variants = context.ui.model.variant.list()
      const describe = (ref: ModelRef | undefined) => (ref ? describeModelRef(ref) : "not picked (OpenCode default model)")
      await context.ui.dialog.alert({
        title: "Fusion pairing",
        message: [
          `lead     ${describe(status.pair?.lead)} → agent ${status.leadAgent}`,
          `sidekick ${describe(status.pair?.sidekick)} → agent ${status.sidekickAgent}`,
          `live model ${selected ? describeModelRef(selected) : "none"}`,
          `live variants ${variants.join(", ") || "none"}`,
          "",
          "run /fusion to change the pair",
        ].join("\n"),
      })
    }

    // Registered through a slot, not `context.keymap.layer` directly: the
    // keymap layers need the host's Solid providers. See src/keymap.tsx.
    const disposeKeymap = claimKeymap(context, () => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "fusion.pair",
          title: "Fusion: pair lead + sidekick models",
          description: "Pick the lead and sidekick models and their effort levels",
          group: "Fusion",
          palette: true,
          slash: { name: "fusion" },
          run: () => pairUp(),
        },
        {
          id: "fusion.stats",
          title: "Fusion: savings report",
          description: "This session's sidekick tokens and what they would have cost at lead rates",
          group: "Fusion",
          palette: true,
          slash: { name: "fusion-stats" },
          run: () => showStats(),
        },
        {
          id: "fusion.show",
          title: "Fusion: show current pairing",
          description: "Show the active lead/sidekick pairing",
          group: "Fusion",
          palette: true,
          run: () => showPairing(),
        },
      ],
      bindings: ["fusion.pair", "fusion.stats", "fusion.show"],
    }))

    return () => {
      offPair()
      for (const off of offSessions) off()
      disposeKeymap()
      disposeStatus()
    }
  },
}

export default plugin
