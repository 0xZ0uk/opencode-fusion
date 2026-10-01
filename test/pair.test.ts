import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { describeModelName, describeModelRef, normalizePair, sameModel, toHostModel } from "../src/pair.ts"

const pair = {
  lead: { providerID: "openai", modelID: "gpt-5.6-sol" },
  sidekick: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
}

describe("normalizePair", () => {
  it("accepts a valid pair and fills agent defaults", () => {
    const result = normalizePair(pair)
    assert.equal(result?.lead.modelID, "gpt-5.6-sol")
    assert.equal(result?.sidekick.variant, "high")
    assert.equal(result?.leadAgent, "fusion")
    assert.equal(result?.sidekickAgent, "sidekick")
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

describe("describeModelName", () => {
  it("drops the provider", () => {
    assert.equal(describeModelName({ modelID: "m", variant: "high" }), "m#high")
    assert.equal(describeModelName({ modelID: "m" }), "m")
  })
})

describe("toHostModel", () => {
  it("maps modelID onto the host's id and keeps the provider", () => {
    assert.deepEqual(toHostModel(pair.lead), { id: "gpt-5.6-sol", providerID: "openai" })
    assert.deepEqual(toHostModel(pair.sidekick), { id: "gpt-5.6-luna", providerID: "openai", variant: "high" })
  })

  it("omits the variant key when the ref has no effort", () => {
    assert.equal("variant" in toHostModel({ providerID: "p", modelID: "m" }), false)
    assert.equal("variant" in toHostModel({ providerID: "p", modelID: "m", variant: "" }), false)
  })
})

describe("sameModel", () => {
  const ref = { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" }

  it("matches an identical host model, whatever shape it arrives in", () => {
    assert.equal(sameModel(ref, toHostModel(ref)), true)
    assert.equal(sameModel(ref, JSON.parse(JSON.stringify(toHostModel(ref)))), true)
  })

  it("notices a provider or model change", () => {
    assert.equal(sameModel(ref, { id: "gpt-5.6-sol", providerID: "openrouter", variant: "high" }), false)
    assert.equal(sameModel(ref, { id: "gpt-5.6-luna", providerID: "openai", variant: "high" }), false)
  })

  it("notices an effort change in either direction", () => {
    assert.equal(sameModel(ref, { id: "gpt-5.6-sol", providerID: "openai", variant: "max" }), false)
    assert.equal(sameModel({ ...ref, variant: "max" }, toHostModel(ref)), false)
    assert.equal(sameModel(ref, { id: "gpt-5.6-sol", providerID: "openai" }), false)
    assert.equal(sameModel(pair.lead, toHostModel(pair.sidekick)), false)
  })

  it("treats an empty variant as the model default on both sides", () => {
    assert.equal(sameModel({ ...ref, variant: "" }, { id: "gpt-5.6-sol", providerID: "openai" }), true)
    assert.equal(sameModel(pair.lead, { id: "gpt-5.6-sol", providerID: "openai", variant: "" }), true)
  })

  it("never matches a model the host did not report", () => {
    assert.equal(sameModel(ref, undefined), false)
    assert.equal(sameModel(ref, null), false)
  })
})
