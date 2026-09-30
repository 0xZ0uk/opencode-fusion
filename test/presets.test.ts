import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ModelInfo } from "@opencode/client"
import { PRESETS, familyOf, resolvePreset } from "../src/presets.ts"

const model = (providerID: string, modelID: string): ModelInfo => ({ providerID, modelID, name: modelID }) as ModelInfo

const chatgpt = PRESETS.find((preset) => preset.name === "ChatGPT")
const custom = PRESETS.find((preset) => preset.name === "Custom")
const go = PRESETS.find((preset) => preset.name === "OpenCode Go")

describe("resolvePreset", () => {
  it("picks candidates in list order on the preset's provider", () => {
    const models = [model("opencode-go", "kimi-k2.6"), model("opencode-go", "kimi-k2.7-code")]
    assert.equal(resolvePreset(models, go!, "lead")?.modelID, "kimi-k2.7-code")
    const withK3 = [model("opencode-go", "kimi-k3"), ...models]
    assert.equal(resolvePreset(withK3, go!, "lead")?.modelID, "kimi-k3")
  })

  it("does not match the same model id on another provider", () => {
    const models = [model("openrouter", "gpt-5.6-sol"), model("openrouter", "gpt-5.6-luna")]
    assert.equal(resolvePreset(models, chatgpt!, "lead"), undefined)
    assert.equal(resolvePreset(models, chatgpt!, "sidekick"), undefined)
    const withOpenai = [...models, model("openai", "gpt-5.6-luna")]
    assert.equal(resolvePreset(withOpenai, chatgpt!, "sidekick")?.providerID, "openai")
  })

  it("returns undefined for Custom (no providerID) and for empty lists", () => {
    assert.equal(resolvePreset([model("openai", "gpt-5.6-sol")], custom!, "lead"), undefined)
    assert.equal(resolvePreset([], chatgpt!, "lead"), undefined)
  })
})

describe("familyOf", () => {
  it("maps known ids to families", () => {
    assert.equal(familyOf({ providerID: "openai", modelID: "gpt-5.6-sol" }), "openai")
    assert.equal(familyOf({ providerID: "opencode", modelID: "claude-opus-5" }), "anthropic")
    assert.equal(familyOf({ providerID: "opencode-go", modelID: "kimi-k3" }), "moonshot")
  })

  it("falls back to the provider id for unknown models", () => {
    assert.equal(familyOf({ providerID: "acme", modelID: "zzz" }), "acme")
  })
})
