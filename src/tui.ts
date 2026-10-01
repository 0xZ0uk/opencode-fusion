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
import { Effect } from "effect"
import { Fusion, fusionClient, type PairStatus } from "./rpc.ts"
import { LEAD_AGENT, SIDEKICK_AGENT, describeModelRef, type FusionPair, type ModelRef } from "./pair.ts"
import { activateLead } from "./tui-activation.ts"
import { collectSavings, type SessionReader } from "./savings.ts"
import { savingsTable } from "./savings-table.ts"
import { showSavingsDialog } from "./savings-dialog.tsx"
import { createCosts } from "./costs.ts"
import { createPairing, toWizardModel, type Catalogue, type Dialogs } from "./pairing.ts"
import { sidekickSessions, type SidekickSession } from "./sidekick-state.ts"
import { versionWarning } from "./version.ts"
import { claimStatus } from "./status.tsx"
import { claimKeymap } from "./keymap.tsx"
import { withTuiRuntime } from "./tui-runtime.ts"

const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

const plugin: Plugin.Definition = {
  id: "opencode-fusion.tui",
  async setup(context) {
    return withTuiRuntime((runtime) => {
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
        "session.agent.selected",
        "session.model.selected",
      ] as const
      const bumpSessions = () =>
        setState((draft) => {
          draft.sessionsVersion += 1
        })
      SESSION_EVENTS.forEach((type) => runtime.register(context.data.on(type, bumpSessions), (off) => off()))

      const catalogue: Effect.Effect<ModelInfo[]> = Effect.gen(function* () {
        const location = context.location ?? context.data.location.default()
        yield* fromPromise(() => context.data.location.model.sync(location)).pipe(
          Effect.catch((error) => Effect.sync(() => console.warn(`[fusion] model sync failed: ${String(error)}`))),
        )
        const list = context.data.location.model.list(location) ?? []
        const available = list.filter((model) => model.enabled !== false)
        return available.length > 0 ? available : list
      })

      const leadPricing = createCosts(() => runtime.runPromise(catalogue))

      const loadPair: Effect.Effect<PairStatus> = fromPromise(() => fusion.getPair()).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            console.warn(`[fusion] server plugin unreachable: ${String(error)}`)
            return { configured: false, leadAgent: LEAD_AGENT, sidekickAgent: SIDEKICK_AGENT }
          }),
        ),
      )

      const applyStatus = (status: PairStatus) =>
        setState((draft) => {
          draft.pair = status.pair
          draft.leadAgent = status.leadAgent
        })

      let pairRevision = 0
      const loadAndApply: Effect.Effect<void> = Effect.gen(function* () {
        const revision = ++pairRevision
        const status = yield* loadPair
        if (revision === pairRevision) applyStatus(status)
      })

      void runtime.runScoped(loadAndApply).catch(() => {})

      runtime.register(
        fusion.events.on("pairChanged", () => {
          void runtime.runScoped(loadAndApply).catch(() => {})
        }),
        (off) => off(),
      )

      runtime.register(claimStatus(context, { state, sessions: sessionSnapshot }), (d) => d())

      // The dialogs and the catalogue, adapted to the wizard's structural seams.
      const dialogs: Dialogs = {
        select: (input) => runtime.runPromise(fromPromise(() => context.ui.dialog.select(input))),
        alert: (input) => runtime.runPromise(fromPromise(() => context.ui.dialog.alert(input))).then(() => undefined),
        toast: (input) => {
          if (!runtime.isDisposed()) context.ui.toast.show(input)
        },
      }
      const wizardCatalogue: Catalogue = {
        models: () => runtime.runPromise(Effect.map(catalogue, (list) => list.map(toWizardModel))),
      }
      const pickPair = createPairing({ dialogs, catalogue: wizardCatalogue })

      const pairUp: Effect.Effect<void, unknown> = Effect.gen(function* () {
        const current = yield* loadPair
        const picked = yield* fromPromise(() => pickPair(current.pair))
        // Undefined means the user backed out at some step; nothing to save.
        if (!picked) return
        const next = picked.pair

        const saved = yield* fromPromise(() => fusion.setPair(next)).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              context.ui.toast.show({ message: `Fusion: failed to save the pair — ${String(error)}`, variant: "error" })
              return undefined
            }),
          ),
        )
        if (!saved) return
        pairRevision += 1
        applyStatus(saved)

        // Follow the lead: move the live session onto the lead agent and the
        // picked lead model now.
        const activated = yield* activateLead(context, saved).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              context.ui.toast.show({
                title: "Fusion",
                message: `pair saved, but live-session activation failed — ${String(error)}`,
                variant: "warning",
              })
              return false
            }),
          ),
        )

        // The wizard returns notes rather than toasting them, so the success
        // toast stays one message composed here.
        if (activated)
          context.ui.toast.show({
            title: "Fusion paired",
            message:
              `lead ${describeModelRef(next.lead)} · sidekick ${describeModelRef(next.sidekick)}` +
              (picked.warnings.length > 0 ? ` · ${picked.warnings.join(" · ")}` : ""),
            variant: "success",
          })
      })

      /**
       * Per-session savings: the current lead session's billed cost, then every
       * sidekick session ever created for it (older ones survive `reset: true`
       * via the server's history) priced per message at lead rates.
       */
      const showStats: Effect.Effect<void, unknown> = Effect.gen(function* () {
        const fail = (message: string) => fromPromise(() => context.ui.dialog.alert({ title: "Fusion savings", message }))
        const route = context.ui.router.current()
        if (route.type !== "session") {
          yield* fail("open a Fusion lead session first")
          return
        }
        const sessionID = route.sessionID
        const status = yield* loadPair
        const snapshot = yield* fromPromise(() => {
          const reader: SessionReader = {
            sessionID,
            getSession: (id) =>
              runtime.runPromise(fromPromise(() => context.client.session.get({ sessionID: id }))),
            sidekickSessions: () =>
              runtime.runPromise(Effect.sync(() => sidekickSessions(sessionSnapshot(), sessionID))),
            listAssistantMessages: (id, cursor) =>
              runtime.runPromise(
                fromPromise(() => context.client.message.list({ sessionID: id, type: "assistant", limit: 100, cursor })),
              ),
            leadPricing,
          }
          return collectSavings(status.pair, reader)
        })
        if (!snapshot) {
          yield* fail("no pair picked yet — run /fusion")
          return
        }
        yield* fromPromise(() => showSavingsDialog(context, savingsTable(snapshot)))
      }).pipe(
        Effect.catch((error) =>
          fromPromise(() => context.ui.dialog.alert({ title: "Fusion savings", message: `unavailable: ${String(error)}` })),
        ),
      )

      const showPairing: Effect.Effect<void, unknown> = Effect.gen(function* () {
        const status = yield* loadPair
        const selected = context.ui.model.current()
        const variants = context.ui.model.variant.list()
        const describe = (ref: ModelRef | undefined) => (ref ? describeModelRef(ref) : "not picked (OpenCode default model)")
        yield* fromPromise(() =>
          context.ui.dialog.alert({
            title: "Fusion pairing",
            message: [
              `lead     ${describe(status.pair?.lead)} → agent ${status.leadAgent}`,
              `sidekick ${describe(status.pair?.sidekick)} → agent ${status.sidekickAgent}`,
              `live model ${selected ? describeModelRef(selected) : "none"}`,
              `live variants ${variants.join(", ") || "none"}`,
              "",
              "run /fusion to change the pair",
            ].join("\n"),
          }),
        )
      })

      // Registered through a slot, not `context.keymap.layer` directly: the
      // keymap layers need the host's Solid providers. See src/keymap.tsx.
      runtime.register(
        claimKeymap(context, () => ({
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
              run: () => runtime.runScoped(pairUp),
            },
            {
              id: "fusion.stats",
              title: "Fusion: savings report",
              description: "This session's sidekick tokens and what they would have cost at lead rates",
              group: "Fusion",
              palette: true,
              slash: { name: "fusion-stats" },
              run: () => runtime.runScoped(showStats),
            },
            {
              id: "fusion.show",
              title: "Fusion: show current pairing",
              description: "Show the active lead/sidekick pairing",
              group: "Fusion",
              palette: true,
              run: () => runtime.runScoped(showPairing),
            },
          ],
          bindings: ["fusion.pair", "fusion.stats", "fusion.show"],
        })),
        (dispose) => dispose(),
      )

    })
  },
}

export default plugin
