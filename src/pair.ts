/**
 * Fusion pair: the lead + sidekick model pairing, plus the agent IDs that carry
 * it. Shared by the server plugin, the TUI plugin and the RPC contract.
 */

/** A model selection, shaped like OpenCode's own `Model.Ref`. `variant` is the effort level. */
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
  /** Effort / reasoning variant, e.g. "high", "max". `undefined` means the model default. */
  readonly variant?: string
}

export interface FusionPair {
  readonly lead: ModelRef
  readonly sidekick: ModelRef
  /** Agent that runs the lead. Must exist in config; the plugin only updates it. */
  readonly leadAgent: string
  /** Agent that runs the sidekick. Must exist in config with `mode: subagent`. */
  readonly sidekickAgent: string
}

export const LEAD_AGENT = "fusion-lead"
export const SIDEKICK_AGENT = "fusion-sidekick"

/**
 * Fallback used when nothing is picked yet. Deliberately a pair of cheap-ish
 * models so a fresh install does not silently burn frontier rates: run `/fusion`
 * to choose the real pairing.
 */
export const DEFAULT_PAIR: FusionPair = {
  lead: { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-pro", variant: "max" },
  sidekick: { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" },
  leadAgent: LEAD_AGENT,
  sidekickAgent: SIDEKICK_AGENT,
}

export function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.providerID === "string" &&
    candidate.providerID.length > 0 &&
    typeof candidate.modelID === "string" &&
    candidate.modelID.length > 0 &&
    (candidate.variant === undefined || typeof candidate.variant === "string")
  )
}

/** Reads a pair out of untrusted storage / RPC input, filling gaps from the default. */
export function normalizePair(value: unknown): FusionPair | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (!isModelRef(candidate.lead) || !isModelRef(candidate.sidekick)) return undefined
  return {
    lead: candidate.lead,
    sidekick: candidate.sidekick,
    leadAgent: typeof candidate.leadAgent === "string" && candidate.leadAgent ? candidate.leadAgent : DEFAULT_PAIR.leadAgent,
    sidekickAgent:
      typeof candidate.sidekickAgent === "string" && candidate.sidekickAgent
        ? candidate.sidekickAgent
        : DEFAULT_PAIR.sidekickAgent,
  }
}

export function describeModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}${ref.variant ? `:${ref.variant}` : ""}`
}
