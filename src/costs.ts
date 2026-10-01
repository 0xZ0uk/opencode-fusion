/**
 * The cost card: what one model costs.
 *
 * Token accounting and the OpenCode catalogue rate cards live here, with the
 * models.dev fallback behind `createCosts`, plus the two sentences other
 * modules show about them — `describeRates` for a picker row and `sourceOf`
 * for the "where did these numbers come from" footnote. Only type imports
 * from `@opencode/*`.
 */
import type { ModelCost, ModelInfo, TokenUsageInfo } from "@opencode/client"
import type { ModelRef } from "./pair.ts"

/** What one model costs: its rates, tiers and where the numbers came from. */
export type CostCard = {
  readonly costs: readonly ModelCost[]
  readonly source?: string
}

/** The source labels a card can carry — each literal lives only here. */
const CATALOGUE_SOURCE = "OpenCode catalogue"
const MODELS_DEV_SOURCE = "models.dev"

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

const MODELS_DEV_URL = "https://models.dev/api.json?type=all"
const CACHE_TTL_MS = 60 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const own = (value: unknown, key: string): unknown =>
  isRecord(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined

const rate = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

export function modelsDevCosts(data: unknown, ref: ModelRef): ModelCost[] {
  const cost = own(own(own(data, ref.providerID), "models"), ref.modelID)
  const card = own(cost, "cost")
  if (!isRecord(card)) return []

  const input = rate(own(card, "input"))
  const output = rate(own(card, "output"))
  if (input === undefined || output === undefined) return []

  const cacheFields = (
    entry: Record<string, unknown>,
    fallback: { read: number; write: number },
  ): { read: number; write: number } | undefined => {
    const read = own(entry, "cache_read")
    const write = own(entry, "cache_write")
    const parsedRead = read === undefined ? fallback.read : rate(read)
    const parsedWrite = write === undefined ? fallback.write : rate(write)
    if (parsedRead === undefined || parsedWrite === undefined) return undefined
    return { read: parsedRead, write: parsedWrite }
  }

  const baseCache = cacheFields(card, { read: 0, write: 0 })
  if (!baseCache) return []
  const base: ModelCost = { input, output, cache: baseCache }

  const tier = (entry: unknown, size: number): ModelCost | undefined => {
    if (!isRecord(entry)) return undefined
    const tierInput = rate(own(entry, "input"))
    const tierOutput = rate(own(entry, "output"))
    if (tierInput === undefined || tierOutput === undefined) return undefined
    const cache = cacheFields(entry, baseCache)
    if (!cache) return undefined
    return { tier: { type: "context", size }, input: tierInput, output: tierOutput, cache }
  }

  const tiers: ModelCost[] = []
  const modern = own(card, "tiers")
  if (Array.isArray(modern)) {
    for (const entry of modern) {
      const marker = own(entry, "tier")
      const size = own(marker, "size")
      if (own(marker, "type") !== "context" || typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
        continue
      }
      const parsed = tier(entry, size)
      if (parsed) tiers.push(parsed)
    }
  }
  if (!Array.isArray(modern) || modern.length === 0) {
    const legacy = tier(own(card, "context_over_200k"), 200_000)
    if (legacy) tiers.push(legacy)
  }
  return [base, ...tiers]
}

async function fetchModelsDev(): Promise<unknown> {
  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`${MODELS_DEV_SOURCE} responded ${response.status}`)
  return response.json()
}

/** The one source label for a card: where its numbers came from. */
export function sourceOf(card: CostCard): string {
  return card.source ?? CATALOGUE_SOURCE
}

export function createCosts(
  catalogue: () => Promise<readonly Pick<ModelInfo, "providerID" | "modelID" | "cost">[]>,
  load: () => Promise<unknown> = fetchModelsDev,
): (ref: ModelRef) => Promise<CostCard> {
  let cached: { at: number; data: unknown } | undefined
  let pending: Promise<unknown> | undefined

  const external = (): Promise<unknown> => {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.data)
    pending ??= load().then(
      (data) => {
        cached = { at: Date.now(), data }
        pending = undefined
        return data
      },
      (error: unknown) => {
        pending = undefined
        throw error
      },
    )
    return pending
  }

  return async (ref: ModelRef): Promise<CostCard> => {
    const models = await catalogue()
    const found = models.find((model) => model.providerID === ref.providerID && model.modelID === ref.modelID)
    const costs = found?.cost ?? []
    if (costs.length > 0) return { costs, source: CATALOGUE_SOURCE }
    let data: unknown
    try {
      data = await external()
    } catch {
      return { costs: [] }
    }
    return { costs: modelsDevCosts(data, ref), source: MODELS_DEV_SOURCE }
  }
}

/**
 * The model's price, for a picker row.
 *
 * `tierFor(costs, 0)` is asking for the *untiered* entry, not pricing a
 * zero-context prompt: with 0 context no context tier can apply, so
 * `tierFor` falls through to the untiered rate. The count of context tiers is
 * shown alongside so the reader knows the price moves with prompt size.
 */
export function describeRates(costs: readonly ModelCost[] | undefined): string {
  const entries = costs ?? []
  const tier = tierFor(entries, 0)
  if (!tier) return "no price data"
  const tiers = entries.filter((cost) => cost.tier?.type === "context").length
  const cache = tier.cache ? ` · cache $${tier.cache.read}/$${tier.cache.write}` : ""
  return `$${tier.input}/M in · $${tier.output}/M out${cache}${tiers > 0 ? ` · +${tiers} context tiers` : ""}`
}
