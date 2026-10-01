/**
 * Model families and subscription presets for the `/fusion` picker.
 *
 * Pure module: type-only imports, so it loads under plain Node for tests.
 * The wizard walk itself lives in pairing.ts; this is the table it consults.
 */

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

export function familyOf(model: { providerID: string; modelID: string }): string {
  const haystack = `${model.providerID}/${model.modelID}`.toLowerCase()
  return FAMILIES.find(([, needles]) => needles.some((needle) => haystack.includes(needle)))?.[0] ?? haystack.split("/")[0] ?? "unknown"
}

/**
 * Subscription presets, borrowed from mihneaptu/opencode-fusion's profile set.
 * Each preset is tied to one provider and lists exact model IDs tried in
 * order — no substring matching across providers.
 */
export type Preset = {
  readonly name: string
  readonly providerID?: string
  readonly lead: readonly string[]
  readonly sidekick: readonly string[]
}

export const PRESETS: readonly Preset[] = [
  { name: "Custom", lead: [], sidekick: [] },
  {
    name: "OpenCode Go",
    providerID: "opencode-go",
    lead: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
    sidekick: ["deepseek-v4.1-flash", "deepseek-v4-flash"],
  },
  {
    name: "OpenCode Zen",
    providerID: "opencode",
    lead: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
    sidekick: ["gpt-5.6-luna", "gpt-6-luna"],
  },
  {
    name: "ChatGPT",
    providerID: "openai",
    lead: ["gpt-5.6-sol", "gpt-6-sol"],
    sidekick: ["gpt-5.6-luna", "gpt-6-luna"],
  },
  {
    name: "GitHub Copilot",
    providerID: "github-copilot",
    lead: ["claude-sonnet-5.5", "claude-sonnet-5"],
    sidekick: ["gpt-5.6-luna", "gpt-6-luna"],
  },
]

/** The one thing a preset lookup needs from a model: its provider and id. */
export type PresetModel = { readonly providerID: string; readonly modelID: string }

/**
 * First candidate (in list order) present on the preset's provider, else
 * undefined. Generic in the caller's model shape, so each caller keeps its own
 * type: the wizard needs `name` for its row labels and the effort titles, which
 * `PresetModel` alone does not carry, while the TUI passes the host's
 * `ModelInfo`.
 */
export function resolvePreset<Model extends PresetModel>(
  models: readonly Model[],
  preset: Preset,
  role: "lead" | "sidekick",
): Model | undefined {
  if (!preset.providerID) return undefined
  for (const candidate of preset[role]) {
    const found = models.find((model) => model.providerID === preset.providerID && model.modelID === candidate)
    if (found) return found
  }
  return undefined
}
