/**
 * Fusion pair: the lead + sidekick model pairing, the agent IDs that carry it,
 * and the translation between a stored `ModelRef` and the host's own model
 * object. Shared by the server plugin, the TUI plugin and the RPC contract.
 *
 * No `@opencode/*` imports at all: `HostModel` is declared here structurally, so
 * the module stays loadable on plain Node and owns both sides of the translation.
 */

/** A model selection, shaped like OpenCode's own `Model.Ref`. `variant` is the effort level. */
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
  /** Effort / reasoning variant, e.g. "high", "max". `undefined` means the model default. */
  readonly variant?: string
}

/**
 * What the host calls a model. Structural on purpose: the host's own model type
 * is branded and its ids are not plain strings, so this stands in for it in both
 * directions (built by `toHostModel`, read back by `sameModel`).
 */
export interface HostModel {
  readonly id: string
  readonly providerID: string
  /** Absent (or `""` from an older value) means the model default. */
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

export const LEAD_AGENT = "fusion"
export const SIDEKICK_AGENT = "sidekick"

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

/** Reads a pair out of untrusted storage / RPC input, filling agent gaps with the defaults. */
export function normalizePair(value: unknown): FusionPair | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (!isModelRef(candidate.lead) || !isModelRef(candidate.sidekick)) return undefined
  return {
    lead: candidate.lead,
    sidekick: candidate.sidekick,
    leadAgent: typeof candidate.leadAgent === "string" && candidate.leadAgent ? candidate.leadAgent : LEAD_AGENT,
    sidekickAgent:
      typeof candidate.sidekickAgent === "string" && candidate.sidekickAgent ? candidate.sidekickAgent : SIDEKICK_AGENT,
  }
}

export function describeModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${describeModelName(ref)}`
}

/** The ref without its provider, for tight slots like the prompt footer. */
export function describeModelName(ref: Pick<ModelRef, "modelID" | "variant">): string {
  // `#` not `:` — model IDs can themselves contain colons.
  return `${ref.modelID}${ref.variant ? `#${ref.variant}` : ""}`
}

/**
 * The one conversion from a stored ref to the host's model object. `modelID` is
 * the host's `id`; the variant key is left off entirely when there is none, so
 * the host applies the model default rather than an empty effort.
 */
export function toHostModel(ref: ModelRef): HostModel {
  return {
    id: ref.modelID,
    providerID: ref.providerID,
    ...(ref.variant ? { variant: ref.variant } : {}),
  }
}

/** Effort as one value: `""`, `null` and `undefined` all mean "the model default". */
const effortOf = (variant: string | null | undefined): string | undefined => (variant ? variant : undefined)

/**
 * The one equality rule between a pair's ref and whatever the host reports:
 * provider, model and effort must all match. A missing host model never
 * matches, so "nothing applied yet" reads as drift.
 */
export function sameModel(ref: ModelRef, host: HostModel | undefined | null): boolean {
  if (!host) return false
  const want = toHostModel(ref)
  return host.id === want.id && host.providerID === want.providerID && effortOf(host.variant) === want.variant
}
