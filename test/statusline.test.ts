import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isLeadSession, statusText, type StatusLineState } from "../src/statusline.ts"
import type { FusionPair, ModelRef } from "../src/pair.ts"

const PAIR: FusionPair = {
  lead: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
  sidekick: { providerID: "openai", modelID: "gpt-5.6-luna" },
  leadAgent: "fusion",
  sidekickAgent: "sidekick",
}

const configured: StatusLineState = { pair: PAIR, leadAgent: "fusion" }
const unconfigured: StatusLineState = { pair: undefined, leadAgent: "fusion" }

describe("isLeadSession", () => {
  it("is true for a session on the lead agent", () => {
    assert.equal(isLeadSession(configured, "ses_1", "fusion"), true)
  })

  it("is false for a session on any other agent", () => {
    assert.equal(isLeadSession(configured, "ses_1", "build"), false)
    assert.equal(isLeadSession(configured, "ses_1", "sidekick"), false)
  })

  it("is false when the session has no agent, or no session is in view", () => {
    assert.equal(isLeadSession(configured, "ses_1", undefined), false)
    assert.equal(isLeadSession(configured, undefined, "fusion"), false)
    assert.equal(isLeadSession(configured, undefined, undefined), false)
  })

  it("follows the configured lead agent rather than a hardcoded one", () => {
    const custom: StatusLineState = { pair: PAIR, leadAgent: "my-lead" }
    assert.equal(isLeadSession(custom, "ses_1", "my-lead"), true)
    assert.equal(isLeadSession(custom, "ses_1", "fusion"), false)
  })
})

describe("statusText", () => {
  it("names the pair, dropping the provider and keeping the variant", () => {
    assert.equal(statusText(configured, "ses_1", false), "fusion gpt-5.6-sol#high ◆ gpt-5.6-luna")
  })

  it("adds the running suffix when this lead's sidekick is working", () => {
    assert.equal(statusText(configured, "ses_1", true), "fusion gpt-5.6-sol#high ◆ gpt-5.6-luna · sidekick running")
  })

  it("prompts for /fusion when no pair is picked, with or without a running flag", () => {
    assert.equal(statusText(unconfigured, "ses_1", false), "fusion · no pair (run /fusion)")
    assert.equal(statusText(unconfigured, "ses_1", true), "fusion · no pair (run /fusion)")
  })

  it("drops the running suffix when no session is in view", () => {
    assert.equal(statusText(configured, undefined, true), "fusion gpt-5.6-sol#high ◆ gpt-5.6-luna")
  })

  it("shows the model default with no variant marker", () => {
    const plain: StatusLineState = {
      pair: { ...PAIR, lead: { providerID: "openai", modelID: "gpt-5.6-sol" } },
      leadAgent: "fusion",
    }
    assert.equal(statusText(plain, "ses_1", false), "fusion gpt-5.6-sol ◆ gpt-5.6-luna")
  })
})

describe("statusText live lead selection", () => {
  const live: ModelRef = { providerID: "anthropic", modelID: "claude-opus-9", variant: "max" }

  it("shows the live model instead of the saved lead", () => {
    assert.equal(statusText(configured, "ses_1", false, live), "fusion claude-opus-9#max ◆ gpt-5.6-luna")
  })

  it("keeps distinct alias ids distinct", () => {
    const alias: ModelRef = { providerID: "openai", modelID: "gpt-5.6-sol-fast", variant: "high" }
    assert.equal(statusText(configured, "ses_1", false, alias), "fusion gpt-5.6-sol-fast#high ◆ gpt-5.6-luna")
  })

  it("shows a live variant that differs from the saved one", () => {
    const effort: ModelRef = { providerID: "openai", modelID: "gpt-5.6-sol", variant: "low" }
    assert.equal(statusText(configured, "ses_1", false, effort), "fusion gpt-5.6-sol#low ◆ gpt-5.6-luna")
  })

  it("shows no variant marker when the live selection is the model default", () => {
    const plain: ModelRef = { providerID: "openai", modelID: "gpt-5.6-sol" }
    assert.equal(statusText(configured, "ses_1", false, plain), "fusion gpt-5.6-sol ◆ gpt-5.6-luna")
  })

  it("falls back to the saved lead when no live model is selected", () => {
    assert.equal(statusText(configured, "ses_1", false, undefined), "fusion gpt-5.6-sol#high ◆ gpt-5.6-luna")
  })

  it("keeps the sidekick and the running suffix off the live selection", () => {
    assert.equal(
      statusText(configured, "ses_1", true, live),
      "fusion claude-opus-9#max ◆ gpt-5.6-luna · sidekick running",
    )
    assert.equal(statusText(unconfigured, "ses_1", false, live), "fusion · no pair (run /fusion)")
  })

  it("does not mutate the saved pair", () => {
    const snapshot = structuredClone(PAIR)
    statusText(configured, "ses_1", false, live)
    assert.deepEqual(configured.pair, snapshot)
  })
})
