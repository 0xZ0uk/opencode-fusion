import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ModelCost } from "@opencode/client"
import { contextOf, priceMessages, pricedAt, tierFor, tokensOf, type Tokens } from "../src/pricing.ts"

const BASE: ModelCost = { input: 10, output: 20, cache: { read: 1, write: 5 } }
const LARGE: ModelCost = { tier: { type: "context", size: 100_000 }, input: 20, output: 40, cache: { read: 2, write: 10 } }
const XLARGE: ModelCost = { tier: { type: "context", size: 500_000 }, input: 30, output: 60, cache: { read: 3, write: 15 } }
const COSTS = [BASE, LARGE, XLARGE]

describe("tierFor", () => {
  it("uses the base tier under the threshold", () => {
    assert.equal(tierFor(COSTS, 50_000), BASE)
    assert.equal(tierFor(COSTS, 0), BASE)
    assert.equal(tierFor(COSTS, 100_000), BASE)
  })

  it("picks the largest applicable context tier", () => {
    assert.equal(tierFor(COSTS, 100_001), LARGE)
    assert.equal(tierFor(COSTS, 600_000), XLARGE)
  })

  it("returns undefined for an empty rate card", () => {
    assert.equal(tierFor([], 0), undefined)
  })

  it("returns costs[0] when nothing is untiered and no tier applies", () => {
    assert.equal(tierFor([LARGE], 10), LARGE)
  })
})

describe("pricedAt", () => {
  const tokens: Tokens = { input: 1_000_000, output: 500_000, reasoning: 500_000, cacheRead: 2_000_000, cacheWrite: 0 }

  it("charges reasoning at the output rate and uses cache rates", () => {
    // 1M in @10 + (0.5M out + 0.5M reasoning) @20 + 2M cacheRead @1 + 0 @5
    assert.equal(pricedAt(tokens, BASE), 10 + 20 + 2)
  })

  it("returns 0 for an undefined rate", () => {
    assert.equal(pricedAt(tokens, undefined), 0)
  })
})

describe("priceMessages", () => {
  it("prices each message at the tier its own context selects", () => {
    const small: Tokens = { input: 50_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const big: Tokens = { input: 600_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    // small context 50k at BASE: $0.50; big context 600k at XLARGE: 600k @30 = $18
    assert.equal(priceMessages([small, big], COSTS), 18.5)
  })
})

describe("contextOf / tokensOf", () => {
  it("counts input plus both cache buckets as context", () => {
    assert.equal(contextOf({ input: 10, output: 99, reasoning: 99, cacheRead: 5, cacheWrite: 3 }), 18)
  })

  it("reads TokenUsageInfo defensively", () => {
    assert.deepEqual(tokensOf(undefined), { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    assert.deepEqual(tokensOf({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }), {
      input: 1,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 5,
    })
  })
})
