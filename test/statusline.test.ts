import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isLeadSession, statusText, type StatusLineState } from "../src/statusline.ts"
import type { FusionPair } from "../src/pair.ts"

const PAIR: FusionPair = {
  lead: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
  sidekick: { providerID: "openai", modelID: "gpt-5.6-luna" },
  leadAgent: "fusion-lead",
  sidekickAgent: "fusion-sidekick",
}

const configured: StatusLineState = { pair: PAIR, leadAgent: "fusion-lead" }
const unconfigured: StatusLineState = { pair: undefined, leadAgent: "fusion-lead" }

describe("isLeadSession", () => {
  it("is true for a session on the lead agent", () => {
    assert.equal(isLeadSession(configured, "ses_1", "fusion-lead"), true)
  })

  it("is false for a session on any other agent", () => {
    assert.equal(isLeadSession(configured, "ses_1", "build"), false)
    assert.equal(isLeadSession(configured, "ses_1", "fusion-sidekick"), false)
  })

  it("is false when the session has no agent, or no session is in view", () => {
    assert.equal(isLeadSession(configured, "ses_1", undefined), false)
    assert.equal(isLeadSession(configured, undefined, "fusion-lead"), false)
    assert.equal(isLeadSession(configured, undefined, undefined), false)
  })

  it("follows the configured lead agent rather than a hardcoded one", () => {
    const custom: StatusLineState = { pair: PAIR, leadAgent: "my-lead" }
    assert.equal(isLeadSession(custom, "ses_1", "my-lead"), true)
    assert.equal(isLeadSession(custom, "ses_1", "fusion-lead"), false)
  })
})

describe("statusText", () => {
  it("names the pair, dropping the provider and keeping the variant", () => {
    assert.equal(statusText(configured, "ses_1", false), "fusion gpt-5.6-sol#high → gpt-5.6-luna")
  })

  it("adds the running suffix when this lead's sidekick is working", () => {
    assert.equal(statusText(configured, "ses_1", true), "fusion gpt-5.6-sol#high → gpt-5.6-luna · sidekick running")
  })

  it("prompts for /fusion when no pair is picked, with or without a running flag", () => {
    assert.equal(statusText(unconfigured, "ses_1", false), "fusion · no pair (run /fusion)")
    assert.equal(statusText(unconfigured, "ses_1", true), "fusion · no pair (run /fusion)")
  })

  it("drops the running suffix when no session is in view", () => {
    assert.equal(statusText(configured, undefined, true), "fusion gpt-5.6-sol#high → gpt-5.6-luna")
  })

  it("shows the model default with no variant marker", () => {
    const plain: StatusLineState = {
      pair: { ...PAIR, lead: { providerID: "openai", modelID: "gpt-5.6-sol" } },
      leadAgent: "fusion-lead",
    }
    assert.equal(statusText(plain, "ses_1", false), "fusion gpt-5.6-sol → gpt-5.6-luna")
  })
})
