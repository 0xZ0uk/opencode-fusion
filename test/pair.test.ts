import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { describeModelRef, normalizePair } from "../src/pair.ts"

const pair = {
  lead: { providerID: "openai", modelID: "gpt-5.6-sol" },
  sidekick: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
}

describe("normalizePair", () => {
  it("accepts a valid pair and fills agent defaults", () => {
    const result = normalizePair(pair)
    assert.equal(result?.lead.modelID, "gpt-5.6-sol")
    assert.equal(result?.sidekick.variant, "high")
    assert.equal(result?.leadAgent, "fusion-lead")
    assert.equal(result?.sidekickAgent, "fusion-sidekick")
  })

  it("keeps custom agent ids", () => {
    const result = normalizePair({ ...pair, leadAgent: "my-lead", sidekickAgent: "my-side" })
    assert.equal(result?.leadAgent, "my-lead")
    assert.equal(result?.sidekickAgent, "my-side")
  })

  it("returns undefined for missing or empty providerID", () => {
    assert.equal(normalizePair({ lead: { modelID: "m" }, sidekick: pair.sidekick }), undefined)
    assert.equal(normalizePair({ lead: { providerID: "", modelID: "m" }, sidekick: pair.sidekick }), undefined)
    assert.equal(normalizePair({ lead: pair.lead, sidekick: { providerID: "", modelID: "m" } }), undefined)
  })

  it("returns undefined for a non-string variant", () => {
    assert.equal(normalizePair({ lead: { providerID: "p", modelID: "m", variant: 3 }, sidekick: pair.sidekick }), undefined)
  })

  it("returns undefined for non-objects", () => {
    assert.equal(normalizePair(undefined), undefined)
    assert.equal(normalizePair("pair"), undefined)
  })
})

describe("describeModelRef", () => {
  it("uses # before the variant", () => {
    assert.equal(describeModelRef({ providerID: "p", modelID: "m", variant: "high" }), "p/m#high")
    assert.equal(describeModelRef({ providerID: "p", modelID: "m" }), "p/m")
  })
})
