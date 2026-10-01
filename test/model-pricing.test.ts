import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ModelCost, ModelInfo } from "@opencode/client"
import { createModelPricing, modelsDevCosts } from "../src/model-pricing.ts"
import { priceMessages, tokensOf } from "../src/pricing.ts"
import type { ModelRef } from "../src/pair.ts"

const REF: ModelRef = { providerID: "prov", modelID: "mod" }

const devData = (cost: unknown, providerID = "prov", modelID = "mod") => ({
  [providerID]: { models: { [modelID]: { cost } } },
})

describe("modelsDevCosts", () => {
  it("maps base rates and cache fields, preserving zeros", () => {
    const costs = modelsDevCosts(
      devData({ input: 2.5, output: 10, cache_read: 0, cache_write: 1.25 }),
      REF,
    )
    assert.deepEqual(costs, [{ input: 2.5, output: 10, cache: { read: 0, write: 1.25 } }])
  })

  it("defaults missing cache fields to zero", () => {
    const costs = modelsDevCosts(devData({ input: 1, output: 2 }), REF)
    assert.deepEqual(costs, [{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
  })

  it("looks up the exact provider and model key only", () => {
    const data = {
      prov: { models: { mod: { cost: { input: 1, output: 2 } }, other: { cost: { input: 9, output: 9 } } } },
      other: { models: { mod: { cost: { input: 8, output: 8 } } } },
    }
    const costs = modelsDevCosts(data, REF)
    assert.equal(costs[0]?.input, 1)
    assert.deepEqual(modelsDevCosts(data, { providerID: "Prov", modelID: "mod" }), [])
    assert.deepEqual(modelsDevCosts(data, { providerID: "prov", modelID: "other" }), [
      { input: 9, output: 9, cache: { read: 0, write: 0 } },
    ])
    assert.deepEqual(modelsDevCosts(data, { providerID: "missing", modelID: "mod" }), [])
  })

  it("does not match through inherited properties", () => {
    const data = devData({ input: 1, output: 2 })
    assert.deepEqual(modelsDevCosts(data, { providerID: "prov", modelID: "constructor" }), [])
    assert.deepEqual(modelsDevCosts(data, { providerID: "hasOwnProperty", modelID: "mod" }), [])
    assert.deepEqual(modelsDevCosts(Object.create(data), REF), [])
  })

  it("requires finite nonnegative base input and output", () => {
    for (const cost of [
      {},
      { input: 1 },
      { output: 2 },
      { input: "1", output: 2 },
      { input: -1, output: 2 },
      { input: Number.NaN, output: 2 },
      { input: 1, output: Number.POSITIVE_INFINITY },
      "flat",
      7,
      null,
    ]) {
      assert.deepEqual(modelsDevCosts(devData(cost), REF), [], JSON.stringify(cost))
    }
  })

  it("ignores a rate with an invalid supplied cache field", () => {
    assert.deepEqual(modelsDevCosts(devData({ input: 1, output: 2, cache_read: "x" }), REF), [])
    assert.deepEqual(modelsDevCosts(devData({ input: 1, output: 2, cache_write: -1 }), REF), [])
  })

  it("parses modern context tiers with their own thresholds and inherited cache", () => {
    const costs = modelsDevCosts(
      devData({
        input: 2.5,
        output: 10,
        cache_read: 0.25,
        tiers: [
          { tier: { type: "context", size: 272_000 }, input: 5, output: 20, cache_write: 1 },
          { tier: { type: "context", size: 700_000 }, input: 7, output: 28, cache_read: 0.5, cache_write: 2 },
        ],
        context_over_200k: { input: 99, output: 99 },
      }),
      REF,
    )
    assert.equal(costs.length, 3)
    assert.deepEqual(costs[0], { input: 2.5, output: 10, cache: { read: 0.25, write: 0 } })
    assert.deepEqual(costs[1], {
      tier: { type: "context", size: 272_000 },
      input: 5,
      output: 20,
      cache: { read: 0.25, write: 1 },
    })
    assert.deepEqual(costs[2], {
      tier: { type: "context", size: 700_000 },
      input: 7,
      output: 28,
      cache: { read: 0.5, write: 2 },
    })
    const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
    close(priceMessages([tokensOf(usage(250_000))], costs), 0.625)
    close(priceMessages([tokensOf(usage(272_000))], costs), 0.68)
    close(priceMessages([tokensOf(usage(300_000))], costs), 1.5)
    close(priceMessages([tokensOf(usage(800_000))], costs), 5.6)
  })

  it("ignores invalid or unsupported tiers", () => {
    const costs = modelsDevCosts(
      devData({
        input: 1,
        output: 2,
        tiers: [
          { tier: { type: "context", size: -5 }, input: 9, output: 9 },
          { tier: { type: "context", size: 100_000 }, input: "x", output: 9 },
          { tier: { type: "requests", size: 100_000 }, input: 9, output: 9 },
          { input: 9, output: 9 },
          { tier: { type: "context", size: 100_000 }, input: 3, output: 6 },
        ],
      }),
      REF,
    )
    assert.deepEqual(costs, [
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
      { tier: { type: "context", size: 100_000 }, input: 3, output: 6, cache: { read: 0, write: 0 } },
    ])
  })

  it("falls back to a valid legacy context_over_200k when modern tiers are absent", () => {
    const costs = modelsDevCosts(
      devData({ input: 1, output: 2, cache_read: 0.1, context_over_200k: { input: 4, output: 8 } }),
      REF,
    )
    assert.deepEqual(costs, [
      { input: 1, output: 2, cache: { read: 0.1, write: 0 } },
      { tier: { type: "context", size: 200_000 }, input: 4, output: 8, cache: { read: 0.1, write: 0 } },
    ])
    const empty = modelsDevCosts(
      devData({ input: 1, output: 2, tiers: [], context_over_200k: { input: 4, output: 8 } }),
      REF,
    )
    assert.equal(empty.length, 2)
  })

  it("does not fabricate rates from malformed legacy or tier data", () => {
    assert.deepEqual(modelsDevCosts(devData({ input: 1, output: 2, context_over_200k: { input: "x" } }), REF), [
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
    ])
    assert.deepEqual(modelsDevCosts(devData({ input: 1, output: 2, tiers: "nope" }), REF), [
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
    ])
  })

  it("never falls back to legacy while a nonempty modern tiers array exists", () => {
    const costs = modelsDevCosts(
      devData({
        input: 1,
        output: 2,
        tiers: [{ tier: { type: "context", size: 272_000 }, input: "x", output: 9 }],
        context_over_200k: { input: 9, output: 9 },
      }),
      REF,
    )
    assert.deepEqual(costs, [{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
  })

  it("preserves zero base rates from models.dev", () => {
    assert.deepEqual(modelsDevCosts(devData({ input: 0, output: 0 }), REF), [
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ])
  })

  it("ignores the ref variant when looking up and pricing", () => {
    const data = devData({ input: 1, output: 2 })
    assert.deepEqual(modelsDevCosts(data, { ...REF, variant: "high" }), modelsDevCosts(data, REF))
  })

  it("does not read inherited rate fields from the cost card", () => {
    const card = Object.create({ input: 1, output: 2 })
    assert.deepEqual(modelsDevCosts(devData(card), REF), [])
    const ownOutput = Object.assign(Object.create({ input: 1 }), { output: 2 })
    assert.deepEqual(modelsDevCosts(devData(ownOutput), REF), [])
  })

  it("ignores a tier whose input/output are only inherited", () => {
    const entry = Object.assign(Object.create({ input: 9, output: 9 }), {
      tier: { type: "context", size: 100_000 },
    })
    const costs = modelsDevCosts(devData({ input: 1, output: 2, tiers: [entry] }), REF)
    assert.deepEqual(costs, [{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
  })
})

const usage = (input: number, output = 0, reasoning = 0, read = 0, write = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

const catalogueOf = (cost: ModelCost[] = []) => async (): Promise<Pick<ModelInfo, "providerID" | "modelID" | "cost">[]> => [
  { providerID: "prov", modelID: "mod", cost },
]

describe("createModelPricing", () => {
  const CATALOGUE_COST: ModelCost = { input: 1, output: 2, cache: { read: 0, write: 0 } }

  it("prefers the OpenCode catalogue without loading externally", async () => {
    let loads = 0
    const resolve = createModelPricing(catalogueOf([CATALOGUE_COST]), async () => {
      loads += 1
      return devData({ input: 9, output: 9 })
    })
    const pricing = await resolve(REF)
    assert.deepEqual(pricing, { costs: [CATALOGUE_COST], source: "OpenCode catalogue" })
    assert.equal(loads, 0)
  })

  it("treats an all-zero OpenCode rate card as authoritative", async () => {
    let loads = 0
    const zero: ModelCost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
    const resolve = createModelPricing(catalogueOf([zero]), async () => {
      loads += 1
      return devData({ input: 9, output: 9 })
    })
    const pricing = await resolve(REF)
    assert.deepEqual(pricing.costs, [zero])
    assert.equal(pricing.source, "OpenCode catalogue")
    assert.equal(loads, 0)
  })

  it("falls back to models.dev when the catalogue cost is missing or empty", async () => {
    const empty = createModelPricing(catalogueOf([]), async () => devData({ input: 3, output: 6 }))
    const pricing = await empty(REF)
    assert.equal(pricing.source, "models.dev")
    assert.deepEqual(pricing.costs, [{ input: 3, output: 6, cache: { read: 0, write: 0 } }])
    const absent = createModelPricing(async () => [], async () => devData({ input: 3, output: 6 }))
    assert.equal((await absent(REF)).source, "models.dev")
  })

  it("propagates catalogue failures", async () => {
    const resolve = createModelPricing(
      async () => {
        throw new Error("sync down")
      },
      async () => devData({ input: 3, output: 6 }),
    )
    await assert.rejects(resolve(REF), /sync down/)
  })

  it("deduplicates concurrent loads and caches for the TTL", async () => {
    let loads = 0
    const resolve = createModelPricing(catalogueOf(undefined), async () => {
      loads += 1
      return devData({ input: 3, output: 6 })
    })
    const [a, b] = await Promise.all([resolve(REF), resolve(REF)])
    assert.equal(a.source, "models.dev")
    assert.equal(b.source, "models.dev")
    assert.equal(loads, 1)
    await resolve(REF)
    assert.equal(loads, 1)
  })

  it("reloads after the TTL expires", async () => {
    let loads = 0
    const realNow = Date.now
    try {
      Date.now = () => 1_000_000
      const resolve = createModelPricing(catalogueOf(undefined), async () => {
        loads += 1
        return devData({ input: 3, output: 6 })
      })
      await resolve(REF)
      Date.now = () => 1_000_000 + 59 * 60 * 1000
      await resolve(REF)
      assert.equal(loads, 1)
      Date.now = () => 1_000_000 + 61 * 60 * 1000
      await resolve(REF)
      assert.equal(loads, 2)
    } finally {
      Date.now = realNow
    }
  })

  it("returns empty costs on load failure and retries next time", async () => {
    let loads = 0
    const resolve = createModelPricing(catalogueOf(undefined), async () => {
      loads += 1
      if (loads === 1) throw new Error("offline")
      return devData({ input: 3, output: 6 })
    })
    const first = await resolve(REF)
    assert.deepEqual(first.costs, [])
    const second = await resolve(REF)
    assert.equal(loads, 2)
    assert.deepEqual(second.costs, [{ input: 3, output: 6, cache: { read: 0, write: 0 } }])
  })

  it("returns empty costs for a malformed payload", async () => {
    const resolve = createModelPricing(catalogueOf(undefined), async () => "not json data")
    assert.deepEqual(await resolve(REF), { costs: [], source: "models.dev" })
  })

  it("returns empty costs when models.dev lacks the model", async () => {
    const resolve = createModelPricing(catalogueOf(undefined), async () => devData({ input: 3, output: 6 }, "other"))
    assert.deepEqual((await resolve(REF)).costs, [])
  })
})
describe("default models.dev loader", () => {
  it("requests the exact endpoint with an AbortSignal and no body", async (t) => {
    const calls: { url: unknown; init: unknown }[] = []
    t.mock.method(globalThis, "fetch", async (url: unknown, init: unknown) => {
      calls.push({ url, init })
      return { ok: true, json: async () => devData({ input: 3, output: 6 }) } as Response
    })
    const resolve = createModelPricing(async () => [])
    const pricing = await resolve(REF)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "https://models.dev/api.json?type=all")
    const init = calls[0]?.init as RequestInit
    assert.equal(init.body, undefined)
    assert.equal(init.method, undefined)
    assert.equal(init.credentials, undefined)
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(Object.keys(init).join(","), "signal")
    assert.equal(pricing.source, "models.dev")
    assert.deepEqual(pricing.costs, [{ input: 3, output: 6, cache: { read: 0, write: 0 } }])
  })

  it("degrades to empty costs on a non-ok response without parsing the body", async (t) => {
    let jsonCalls = 0
    t.mock.method(globalThis, "fetch", async () => {
      return {
        ok: false,
        status: 403,
        json: async () => {
          jsonCalls += 1
          return {}
        },
      } as Response
    })
    const resolve = createModelPricing(async () => [])
    assert.deepEqual(await resolve(REF), { costs: [] })
    assert.equal(jsonCalls, 0)
  })

  it("retries on the next request after a json() failure", async (t) => {
    let fetches = 0
    t.mock.method(globalThis, "fetch", async () => {
      fetches += 1
      return {
        ok: true,
        json: async () => {
          if (fetches === 1) throw new Error("truncated body")
          return devData({ input: 3, output: 6 })
        },
      } as Response
    })
    const resolve = createModelPricing(async () => [])
    assert.deepEqual((await resolve(REF)).costs, [])
    assert.deepEqual((await resolve(REF)).costs, [
      { input: 3, output: 6, cache: { read: 0, write: 0 } },
    ])
    assert.equal(fetches, 2)
  })
})
