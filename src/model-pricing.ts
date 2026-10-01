import type { ModelCost, ModelInfo } from "@opencode/client"
import type { ModelRef } from "./pair.ts"

export interface LeadPricing {
  readonly costs: readonly ModelCost[]
  readonly source?: string
}

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
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
  return response.json()
}

export function createModelPricing(
  catalogue: () => Promise<readonly Pick<ModelInfo, "providerID" | "modelID" | "cost">[]>,
  load: () => Promise<unknown> = fetchModelsDev,
): (ref: ModelRef) => Promise<LeadPricing> {
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

  return async (ref: ModelRef): Promise<LeadPricing> => {
    const models = await catalogue()
    const found = models.find((model) => model.providerID === ref.providerID && model.modelID === ref.modelID)
    const costs = found?.cost ?? []
    if (costs.length > 0) return { costs, source: "OpenCode catalogue" }
    let data: unknown
    try {
      data = await external()
    } catch {
      return { costs: [] }
    }
    return { costs: modelsDevCosts(data, ref), source: "models.dev" }
  }
}
