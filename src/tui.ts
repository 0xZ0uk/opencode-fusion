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
import { Fusion } from "./rpc.ts"
import { LEAD_AGENT, SIDEKICK_AGENT, describeModelRef, toHostModel, type FusionPair, type ModelRef } from "./pair.ts"
import { EMPTY_TOKENS, addTokens, money, priceMessages, tierFor, tokensOf, type Tokens } from "./pricing.ts"
import { PRESETS, familyOf, resolvePreset } from "./presets.ts"
import { versionWarning } from "./version.ts"
import { claimStatus } from "./status.tsx"
import { claimKeymap } from "./keymap.tsx"

/** Dialog value meaning "use the model's default effort". */
const MODEL_DEFAULT = ""

/** What getPair returns; `pair` is absent until one is picked. */
type PairStatus = { configured: boolean; pair?: FusionPair; leadAgent: string; sidekickAgent: string }

/** What the `sidekicks` RPC returns for one lead session. */
type SidekicksResult = { current?: string; sessionIDs: string[]; running: boolean }

const modelKey = (ref: { providerID: string; modelID: string }): string => `${ref.providerID}|${ref.modelID}`

function splitKey(value: string): { providerID: string; modelID: string } | undefined {
  const index = value.indexOf("|")
  if (index <= 0) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

function rate(model: ModelInfo): string {
  const tier = tierFor(model.cost ?? [], 0)
  if (!tier) return "no price data"
  const tiers = (model.cost ?? []).filter((cost) => cost.tier?.type === "context").length
  const cache = tier.cache ? ` · cache $${tier.cache.read}/$${tier.cache.write}` : ""
  return `$${tier.input}/M in · $${tier.output}/M out${cache}${tiers > 0 ? ` · +${tiers} context tiers` : ""}`
}

function contextSize(model: ModelInfo): string {
  const context = model.limit?.context
  return typeof context === "number" ? `${Math.round(context / 1000)}k ctx` : "unknown ctx"
}

function modelOptions(models: ModelInfo[]) {
  return models.map((model) => ({
    title: model.name,
    value: modelKey(model),
    description: `${model.providerID} · ${contextSize(model)} · ${rate(model)}`,
    category: model.providerID,
  }))
}

function effortOptions(model: ModelInfo) {
  const variants = (model.variants ?? []).map((variant) => variant.id).filter(Boolean)
  return [
    { title: "model default", value: MODEL_DEFAULT, description: `${model.name} default effort` },
    ...variants.map((id) => ({ title: id, value: id, description: `effort variant "${id}"` })),
  ]
}

const formatTokens = (tokens: Tokens): string =>
  `${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out · ${tokens.reasoning.toLocaleString()} reasoning`

const plugin: Plugin.Definition = {
  id: "opencode-fusion.tui",
  async setup(context) {
    const fusion = context.client.rpc(Fusion)

    const warning = versionWarning(context.app?.version)
    if (warning) context.ui.toast.show({ title: "Fusion", message: warning, variant: "warning" })

    // Reactive status-slot state: the pair, the lead agent id, and per-lead
    // "sidekick running" flags fed by the handoffChanged event.
    const [state, setState] = context.storage.memory("fusion-status", {
      initial: {
        pair: undefined as FusionPair | undefined,
        leadAgent: LEAD_AGENT,
        running: {} as Record<string, boolean>,
      },
    })

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

    const loadPair = async (): Promise<PairStatus> => {
      try {
        // RPC values come back as `unknown`: JSON Schemas do not carry TypeScript types.
        return (await fusion.getPair({})) as PairStatus
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
    const offHandoff = fusion.events.on("handoffChanged", (event) => {
      const data = event.data as { leadSessionID: string; running: boolean }
      setState((draft) => {
        draft.running[data.leadSessionID] = data.running
      })
    })

    const refreshRunning = (sessionID: string) => {
      void fusion
        .sidekicks({ sessionID })
        .then((result) => {
          const { running } = result as SidekicksResult
          setState((draft) => {
            draft.running[sessionID] = running
          })
        })
        .catch(() => {})
    }
    const disposeStatus = claimStatus(context, { state, refreshRunning })

    const pickModel = async (title: string, models: ModelInfo[], current?: ModelRef): Promise<ModelRef | undefined> => {
      const value = await context.ui.dialog.select({
        title,
        placeholder: "Search models",
        options: modelOptions(models),
        ...(current ? { current: modelKey(current) } : {}),
      })
      if (!value) return undefined
      return splitKey(value)
    }

    /** Chosen variant ("" = model default), or null when cancelled. */
    const pickEffort = async (
      title: string,
      models: ModelInfo[],
      picked: { providerID: string; modelID: string },
      current?: ModelRef,
    ): Promise<string | null> => {
      const model = models.find((entry) => modelKey(entry) === modelKey(picked))
      if (!model || (model.variants ?? []).length === 0) return MODEL_DEFAULT
      const currentVariant = current && modelKey(current) === modelKey(picked) ? current.variant : undefined
      const value = await context.ui.dialog.select({
        title,
        placeholder: "Effort",
        options: effortOptions(model),
        current: currentVariant ?? MODEL_DEFAULT,
      })
      return value === undefined ? null : value
    }

    const pairUp = async (): Promise<void> => {
      const models = await catalogue()
      if (models.length === 0) {
        context.ui.toast.show({ message: "Fusion: no models available at this location", variant: "error" })
        return
      }
      const current = await loadPair()

      const presetName = await context.ui.dialog.select({
        title: "Fusion 0/4 · Preset",
        placeholder: "Preset or custom",
        options: PRESETS.map((preset) => {
          if (!preset.providerID) {
            return { title: preset.name, value: preset.name, description: "pick lead and sidekick by hand" }
          }
          const lead = resolvePreset(models, preset, "lead")
          const sidekick = resolvePreset(models, preset, "sidekick")
          return lead && sidekick
            ? { title: preset.name, value: preset.name, description: `${lead.name} lead · ${sidekick.name} sidekick` }
            : { title: preset.name, value: preset.name, description: "not available at this location", disabled: true }
        }),
      })
      if (!presetName) return
      const preset = PRESETS.find((entry) => entry.name === presetName)
      const presetLead = preset ? resolvePreset(models, preset, "lead") : undefined
      const presetSidekick = preset ? resolvePreset(models, preset, "sidekick") : undefined
      const presetFits = Boolean(presetLead && presetSidekick)
      if (preset && preset.name !== "Custom" && !presetFits) {
        context.ui.toast.show({
          message: `Fusion: preset "${preset.name}" has no matching models here — pick manually`,
          variant: "error",
        })
      }

      let lead: ModelRef | undefined
      let sidekick: ModelRef | undefined
      let leadEffort: string | null = MODEL_DEFAULT
      let sidekickEffort: string | null = MODEL_DEFAULT

      if (presetFits && presetLead && presetSidekick) {
        lead = { providerID: presetLead.providerID, modelID: presetLead.modelID }
        sidekick = { providerID: presetSidekick.providerID, modelID: presetSidekick.modelID }
        leadEffort = await pickEffort(`Fusion 2/4 · Lead effort (${presetLead.name})`, models, lead, current.pair?.lead)
        if (leadEffort === null) return
        sidekickEffort = await pickEffort(
          `Fusion 4/4 · Sidekick effort (${presetSidekick.name})`,
          models,
          sidekick,
          current.pair?.sidekick,
        )
        if (sidekickEffort === null) return
      } else {
        lead = await pickModel("Fusion 1/4 · Lead model", models, current.pair?.lead)
        if (!lead) return
        leadEffort = await pickEffort("Fusion 2/4 · Lead effort", models, lead, current.pair?.lead)
        if (leadEffort === null) return

        sidekick = await pickModel("Fusion 3/4 · Sidekick model", models, current.pair?.sidekick)
        if (!sidekick) return
        sidekickEffort = await pickEffort("Fusion 4/4 · Sidekick effort", models, sidekick, current.pair?.sidekick)
        if (sidekickEffort === null) return
      }

      const next = {
        lead: { ...lead, ...(leadEffort ? { variant: leadEffort } : {}) },
        sidekick: { ...sidekick, ...(sidekickEffort ? { variant: sidekickEffort } : {}) },
      }

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

      const leadFamily = familyOf(next.lead)
      const sidekickFamily = familyOf(next.sidekick)
      context.ui.toast.show({
        title: "Fusion paired",
        message:
          `lead ${describeModelRef(next.lead)} · sidekick ${describeModelRef(next.sidekick)}` +
          (leadFamily === sidekickFamily ? ` · same family (${leadFamily}): no independent cross-vendor review` : ""),
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
        const status = await loadPair()
        const pair = status.pair
        if (!pair) {
          await fail("no pair picked yet — run /fusion")
          return
        }
        const sessionID = route.sessionID
        const [sidekicks, models, leadSession] = await Promise.all([
          fusion.sidekicks({ sessionID }),
          catalogue(),
          context.client.session.get({ sessionID }),
        ])
        const { sessionIDs } = sidekicks as SidekicksResult
        let sidekickCost = 0
        let sidekickTokens = EMPTY_TOKENS
        let sessions = 0
        const perMessage: Tokens[] = []
        for (const sidekickID of sessionIDs) {
          let sidekickSession
          try {
            sidekickSession = await context.client.session.get({ sessionID: sidekickID })
          } catch {
            continue
          }
          sessions += 1
          sidekickCost += sidekickSession.cost
          sidekickTokens = addTokens(sidekickTokens, tokensOf(sidekickSession.tokens))
          let cursor: string | undefined
          do {
            const page = await context.client.message.list({
              sessionID: sidekickID,
              type: "assistant",
              limit: 100,
              cursor,
            })
            for (const message of page.data) {
              if (message.type === "assistant") perMessage.push(tokensOf(message.tokens))
            }
            cursor = page.cursor.next ?? undefined
          } while (cursor)
        }
        const leadModel = models.find(
          (entry) => entry.providerID === pair.lead.providerID && entry.modelID === pair.lead.modelID,
        )
        const costs = leadModel?.cost ?? []
        const lines = [
          `lead     ${describeModelRef(pair.lead)}`,
          `         ${formatTokens(tokensOf(leadSession.tokens))} · billed ${money(leadSession.cost)}`,
          `sidekick ${describeModelRef(pair.sidekick)} · ${sessions} session${sessions === 1 ? "" : "s"}`,
          `         ${formatTokens(sidekickTokens)} · billed ${money(sidekickCost)}`,
          "",
          `total billed: ${money(leadSession.cost + sidekickCost)}`,
        ]
        if (costs.length > 0) {
          const atLeadRates = priceMessages(perMessage, costs)
          lines.push(
            `same sidekick work at lead rates: ${money(atLeadRates)}`,
            `estimated saving: ${money(Math.max(atLeadRates - sidekickCost, 0))}`,
          )
        } else {
          lines.push("no price data for the lead model — cannot estimate the saving")
        }
        lines.push(
          "",
          "the lead-rate figure is priced per sidekick message from the catalogue (context tier per message, reasoning at output rate); billed figures are OpenCode's recorded session costs",
        )
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
      offHandoff()
      disposeKeymap()
      disposeStatus()
    }
  },
}

export default plugin
