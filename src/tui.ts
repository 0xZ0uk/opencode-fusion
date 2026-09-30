/**
 * TUI half of Fusion.
 *
 * `/fusion` walks lead model → lead effort → sidekick model → sidekick effort
 * through the models OpenCode actually has available at this location, saves
 * the pair through the server plugin, and moves the live session onto the lead.
 *
 * Effort is OpenCode's own model `variant` (undefined = model default) — the
 * same knob the built-in variant cycle uses.
 */
import type { Plugin } from "@opencode/plugin/tui"
import type { ModelInfo, SessionStatsInfo } from "@opencode/client"
import { Fusion } from "./rpc.ts"
import { DEFAULT_PAIR, describeModelRef, type FusionPair, type ModelRef } from "./pair.ts"
import { EMPTY_USAGE, addUsage, matches, money, pricedAt, rateOf, usageOf } from "./pricing.ts"

/** Dialog value meaning "use the model's default effort". */
const MODEL_DEFAULT = ""

const modelKey = (ref: { providerID: string; modelID: string }): string => `${ref.providerID}|${ref.modelID}`

function splitKey(value: string): { providerID: string; modelID: string } | undefined {
  const index = value.indexOf("|")
  if (index <= 0) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

function rate(model: ModelInfo): string {
  const tier = model.cost?.[0]
  if (!tier) return "no price data"
  const cache = tier.cache ? ` · cache $${tier.cache.read}/$${tier.cache.write}` : ""
  return `$${tier.input}/M in · $${tier.output}/M out${cache}`
}

function contextSize(model: ModelInfo): string {
  const context = model.limit?.context
  return typeof context === "number" ? `${Math.round(context / 1000)}k ctx` : "unknown ctx"
}

function modelOptions(models: ModelInfo[], current: ModelRef) {
  return models.map((model) => ({
    title: model.name,
    value: modelKey(model),
    description: `${model.providerID} · ${contextSize(model)} · ${rate(model)}`,
    category: model.providerID,
    footer: modelKey(model) === modelKey(current) ? "current" : undefined,
  }))
}

function effortOptions(model: ModelInfo, current: string | undefined) {
  const variants = (model.variants ?? []).map((variant) => variant.id).filter(Boolean)
  const options = [
    { title: "model default", value: MODEL_DEFAULT, description: `${model.name} default effort` },
    ...variants.map((id) => ({ title: id, value: id, description: `effort variant "${id}"` })),
  ]
  return options.map((option) => ({ ...option, footer: option.value === (current ?? MODEL_DEFAULT) ? "current" : undefined }))
}

/**
 * Model family, for the cross-vendor check. A lead and sidekick from the same
 * family share blind spots, which throws away the free independent review the
 * pairing buys you.
 */
const FAMILIES: Array<[string, string[]]> = [
  ["anthropic", ["claude", "anthropic", "opus", "sonnet", "haiku"]],
  ["openai", ["gpt", "openai", "o1", "o3", "o4", "codex"]],
  ["google", ["gemini", "google", "gemma"]],
  ["deepseek", ["deepseek"]],
  ["zai", ["glm", "z-ai", "zai"]],
  ["moonshot", ["kimi", "moonshot"]],
  ["meta", ["llama", "meta"]],
  ["xai", ["grok", "x-ai", "xai"]],
  ["mistral", ["mistral", "magistral", "devstral"]],
  ["qwen", ["qwen", "alibaba"]],
]

function familyOf(model: { providerID: string; modelID: string }): string {
  const haystack = `${model.providerID}/${model.modelID}`.toLowerCase()
  return FAMILIES.find(([, needles]) => needles.some((needle) => haystack.includes(needle)))?.[0] ?? haystack.split("/")[0] ?? "unknown"
}

/**
 * Subscription presets, borrowed from mihneaptu/opencode-fusion's profile set.
 * Patterns are matched against the live catalogue; anything unmatched falls
 * through to the manual picker instead of guessing.
 */
const PRESETS: Array<{ name: string; description: string; lead: string[]; sidekick: string[] }> = [
  { name: "Custom", description: "pick lead and sidekick by hand", lead: [], sidekick: [] },
  { name: "OpenCode Go", description: "Kimi K3 lead · DeepSeek V4 Flash sidekick", lead: ["kimi"], sidekick: ["deepseek"] },
  { name: "OpenCode Zen", description: "Claude Opus lead · GPT-5.6 Luna sidekick", lead: ["opus"], sidekick: ["luna"] },
  { name: "ChatGPT", description: "GPT-5.6 Sol lead · GPT-5.6 Luna sidekick", lead: ["sol"], sidekick: ["luna"] },
  { name: "GitHub Copilot", description: "Claude Sonnet lead · GPT-5.6 Luna sidekick", lead: ["sonnet"], sidekick: ["luna"] },
]

function resolvePreset(models: ModelInfo[], needles: string[]): ModelInfo | undefined {
  if (needles.length === 0) return undefined
  return models.find((model) => {
    const haystack = `${model.providerID}/${model.modelID}/${model.name}`.toLowerCase()
    return needles.some((needle) => haystack.includes(needle))
  })
}

const plugin: Plugin.Definition = {
  id: "opencode-fusion.tui",
  async setup(context) {
    const fusion = context.client.rpc(Fusion)

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

    const loadPair = async (): Promise<FusionPair> => {
      try {
        // RPC values come back as `unknown`: JSON Schemas do not carry TypeScript types.
        const result = (await fusion.getPair({})) as { configured: boolean; pair: FusionPair }
        return result.pair
      } catch (error) {
        console.warn(`[fusion] server plugin unreachable: ${String(error)}`)
        return DEFAULT_PAIR
      }
    }

    const pickModel = async (title: string, models: ModelInfo[], current: ModelRef): Promise<ModelRef | undefined> => {
      const value = await context.ui.dialog.select({
        title,
        placeholder: "Search models",
        options: modelOptions(models, current),
      })
      if (!value) return undefined
      return splitKey(value)
    }

    /** Chosen variant ("" = model default), or null when cancelled. */
    const pickEffort = async (
      title: string,
      models: ModelInfo[],
      picked: { providerID: string; modelID: string },
      current: ModelRef,
    ): Promise<string | null> => {
      const model = models.find((entry) => modelKey(entry) === modelKey(picked))
      if (!model || (model.variants ?? []).length === 0) return MODEL_DEFAULT
      const value = await context.ui.dialog.select({
        title,
        placeholder: "Effort",
        options: effortOptions(model, modelKey(current) === modelKey(picked) ? current.variant : undefined),
      })
      return value === undefined ? null : value
    }

    const pairUp = async (): Promise<void> => {
      const models = await catalogue()
      if (models.length === 0) {
        await context.ui.toast.show({ message: "Fusion: no models available at this location", variant: "error" })
        return
      }
      const current = await loadPair()

      const presetName = await context.ui.dialog.select({
        title: "Fusion 0/4 · Preset",
        placeholder: "Preset or custom",
        options: PRESETS.map((preset) => ({ title: preset.name, value: preset.name, description: preset.description })),
      })
      if (!presetName) return
      const preset = PRESETS.find((entry) => entry.name === presetName)
      const presetLead = preset ? resolvePreset(models, preset.lead) : undefined
      const presetSidekick = preset ? resolvePreset(models, preset.sidekick) : undefined
      const presetFits = Boolean(presetLead && presetSidekick)
      if (preset && preset.name !== "Custom" && !presetFits) {
        await context.ui.toast.show({
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
        leadEffort = await pickEffort(`Fusion 2/4 · Lead effort (${presetLead.name})`, models, lead, current.lead)
        if (leadEffort === null) return
        sidekickEffort = await pickEffort(`Fusion 4/4 · Sidekick effort (${presetSidekick.name})`, models, sidekick, current.sidekick)
        if (sidekickEffort === null) return
      } else {
        lead = await pickModel("Fusion 1/4 · Lead model", models, current.lead)
        if (!lead) return
        leadEffort = await pickEffort("Fusion 2/4 · Lead effort", models, lead, current.lead)
        if (leadEffort === null) return

        sidekick = await pickModel("Fusion 3/4 · Sidekick model", models, current.sidekick)
        if (!sidekick) return
        sidekickEffort = await pickEffort("Fusion 4/4 · Sidekick effort", models, sidekick, current.sidekick)
        if (sidekickEffort === null) return
      }

      const next = {
        lead: { ...lead, ...(leadEffort ? { variant: leadEffort } : {}) },
        sidekick: { ...sidekick, ...(sidekickEffort ? { variant: sidekickEffort } : {}) },
        leadAgent: current.leadAgent,
        sidekickAgent: current.sidekickAgent,
      }

      try {
        await fusion.setPair(next)
      } catch (error) {
        await context.ui.toast.show({ message: `Fusion: failed to save the pair — ${String(error)}`, variant: "error" })
        return
      }

      // Follow the lead: move the live session onto the picked lead model now.
      const route = context.ui.router.current()
      if (route.type === "session") {
        try {
          await context.client.session.switchModel({
            sessionID: route.sessionID,
            model: {
              id: next.lead.modelID,
              providerID: next.lead.providerID,
              ...(next.lead.variant ? { variant: next.lead.variant } : {}),
            },
          })
        } catch (error) {
          console.warn(`[fusion] could not switch the live session model: ${String(error)}`)
        }
      }

      const leadFamily = familyOf(next.lead)
      const sidekickFamily = familyOf(next.sidekick)
      await context.ui.toast.show({
        title: "Fusion paired",
        message:
          `lead ${describeModelRef(next.lead)} · sidekick ${describeModelRef(next.sidekick)}` +
          (leadFamily === sidekickFamily ? ` · same family (${leadFamily}): no independent cross-vendor review` : ""),
        variant: "success",
      })
    }

    const showStats = async (): Promise<void> => {
      try {
        const [usage, models, pair] = (await Promise.all([
          context.client.session.stats({}),
          catalogue(),
          loadPair(),
        ])) as [SessionStatsInfo, ModelInfo[], FusionPair]
        const entries = (usage.models ?? []).filter(
          (entry) => matches(entry, pair.lead) || matches(entry, pair.sidekick),
        )
        const lead = entries.filter((entry) => matches(entry, pair.lead)).map(usageOf).reduce(addUsage, EMPTY_USAGE)
        const sidekick = entries.filter((entry) => matches(entry, pair.sidekick)).map(usageOf).reduce(addUsage, EMPTY_USAGE)
        const atLeadRates = pricedAt(sidekick.tokens, rateOf(models, pair.lead))
        const saved = Math.max(atLeadRates - sidekick.cost, 0)
        const text = [
          `lead     ${describeModelRef(pair.lead)}`,
          `         ${lead.tokens.output.toLocaleString()} out · ${money(lead.cost)}`,
          `sidekick ${describeModelRef(pair.sidekick)}`,
          `         ${sidekick.tokens.output.toLocaleString()} out · ${money(sidekick.cost)}`,
          "",
          `same sidekick work at lead rates: ${money(atLeadRates)}`,
          `estimated saving: ${money(saved)}`,
          "",
          "estimated only: token buckets are priced from the model catalogue and cache rates are assumptions, not billed totals",
        ].join("\n")
        await context.ui.dialog.alert({ title: "Fusion savings", message: text })
      } catch (error) {
        await context.ui.dialog.alert({ title: "Fusion savings", message: `unavailable: ${String(error)}` })
      }
    }

    const showPairing = async (): Promise<void> => {
      const pair = await loadPair()
      const selected = context.ui.model.current()
      const variants = context.ui.model.variant.list()
      await context.ui.dialog.alert({
        title: "Fusion pairing",
        message: [
          `lead     ${describeModelRef(pair.lead)} → agent ${pair.leadAgent}`,
          `sidekick ${describeModelRef(pair.sidekick)} → agent ${pair.sidekickAgent}`,
          `live model ${selected ? `${selected.providerID}/${selected.modelID}${selected.variant ? `#${selected.variant}` : ""}` : "none"}`,
          `live variants ${variants.join(", ") || "none"}`,
          "",
          "run /fusion to change the pair",
        ].join("\n"),
      })
    }

    return context.keymap.layer(() => ({
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
          description: "Sidekick tokens and what they would have cost at lead rates",
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
  },
}

export default plugin
