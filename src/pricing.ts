/** Token accounting and catalogue pricing shared by the savings report. */
import type { ModelCost, TokenUsageInfo } from "@opencode/client"

export type Tokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export const EMPTY_TOKENS: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/** Reads OpenCode's `TokenUsageInfo` defensively — field names come from the API, not from us. */
export function tokensOf(usage: TokenUsageInfo | undefined): Tokens {
  const record = (usage ?? {}) as Record<string, unknown>
  const cache = (record.cache ?? {}) as Record<string, unknown>
  return {
    input: finite(record.input),
    output: finite(record.output),
    reasoning: finite(record.reasoning),
    cacheRead: finite(cache.read),
    cacheWrite: finite(cache.write),
  }
}

export function addTokens(left: Tokens, right: Tokens): Tokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

/** Prompt size for tier selection: everything the model reads, including cached prefixes. */
export const contextOf = (tokens: Tokens): number => tokens.input + tokens.cacheRead + tokens.cacheWrite

/**
 * The rate for a prompt of `contextTokens`: the largest applicable context
 * tier, else the first untiered entry, else the first entry at all.
 */
export function tierFor(costs: readonly ModelCost[], contextTokens: number): ModelCost | undefined {
  let best: ModelCost | undefined
  for (const cost of costs) {
    if (cost.tier?.type !== "context" || contextTokens <= cost.tier.size) continue
    if (!best || cost.tier.size > (best.tier?.size ?? 0)) best = cost
  }
  if (best) return best
  return costs.find((cost) => cost.tier === undefined) ?? costs[0]
}

/** What these tokens would have cost at `rate` (USD per million tokens). Reasoning bills at output rate. */
export function pricedAt(tokens: Tokens, rate: ModelCost | undefined): number {
  if (!rate) return 0
  const per = (value: unknown) => finite(value) / 1_000_000
  return (
    tokens.input * per(rate.input) +
    (tokens.output + tokens.reasoning) * per(rate.output) +
    tokens.cacheRead * per(rate.cache?.read) +
    tokens.cacheWrite * per(rate.cache?.write)
  )
}

/** Total price of a message list, each priced at the tier its own prompt size selects. */
export function priceMessages(perMessage: readonly Tokens[], costs: readonly ModelCost[]): number {
  return perMessage.reduce((sum, tokens) => sum + pricedAt(tokens, tierFor(costs, contextOf(tokens))), 0)
}

export const money = (value: number): string => `$${value.toFixed(4)}`
