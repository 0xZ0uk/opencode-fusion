/** Token accounting shared by the savings report. */
import type { ModelInfo } from "@opencode/client"

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Usage = { tokens: Tokens; cost: number }
export type ModelRefLike = { providerID: string; id: string }

export const EMPTY_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const EMPTY_USAGE: Usage = { tokens: EMPTY_TOKENS, cost: 0 }

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/** Reads OpenCode's `TokenUsage` shape defensively — field names come from the API, not from us. */
export function tokensOf(usage: unknown): Tokens {
  const record = (usage ?? {}) as Record<string, unknown>
  const tokens = (record.tokens ?? {}) as Record<string, unknown>
  const cache = (tokens.cache ?? {}) as Record<string, unknown>
  return {
    input: finite(tokens.input),
    output: finite(tokens.output),
    cacheRead: finite(cache.read),
    cacheWrite: finite(cache.write),
  }
}

export function addTokens(left: Tokens, right: Tokens): Tokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

export function addUsage(left: Usage, right: Usage): Usage {
  return { tokens: addTokens(left.tokens, right.tokens), cost: left.cost + right.cost }
}

export function usageOf(entry: unknown): Usage {
  return { tokens: tokensOf(entry), cost: finite((entry as Record<string, unknown>)?.cost) }
}

export function matches(entry: unknown, ref: { providerID: string; modelID: string }): boolean {
  const model = ((entry as Record<string, unknown>)?.model ?? {}) as Record<string, unknown>
  return model.providerID === ref.providerID && (model.id === ref.modelID || model.model === ref.modelID)
}

export function rateOf(catalogue: ModelInfo[], ref: { providerID: string; modelID: string }): ModelInfo["cost"][number] | undefined {
  const model = catalogue.find((entry) => entry.providerID === ref.providerID && entry.modelID === ref.modelID)
  return model?.cost?.[0]
}

/** What these tokens would have cost at `rate` (USD per million tokens). */
export function pricedAt(tokens: Tokens, rate: ModelInfo["cost"][number] | undefined): number {
  if (!rate) return 0
  const per = (value: unknown) => finite(value) / 1_000_000
  return (
    tokens.input * per(rate.input) +
    tokens.output * per(rate.output) +
    tokens.cacheRead * per(rate.cache?.read) +
    tokens.cacheWrite * per(rate.cache?.write)
  )
}

export const money = (value: number): string => `$${value.toFixed(4)}`
