import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createPairing, type Dialogs, type SelectOption, type WizardModel } from "../src/pairing.ts"
import type { ModelRef } from "../src/pair.ts"

// --- fakes -------------------------------------------------------------------

const model = (
  providerID: string,
  modelID: string,
  extra: Partial<WizardModel> = {},
): WizardModel => ({
  providerID,
  modelID,
  name: `${modelID} name`,
  variants: [{ id: "high" }, { id: "max" }],
  ...extra,
})

type Ask = { title: string; current?: string; options: readonly SelectOption[] }

/** Dialogs fake: replays a scripted answer per select, and records every ask. */
function fakeDialogs(answers: readonly (string | undefined)[]) {
  const asks: Ask[] = []
  const toasts: Array<{ title?: string; message: string; variant?: string }> = []
  let index = 0
  const dialogs: Dialogs = {
    async select(input) {
      asks.push({ title: input.title, ...(input.current !== undefined ? { current: input.current } : {}), options: input.options })
      return answers[index++]
    },
    async alert() {},
    toast(input) {
      toasts.push(input)
    },
  }
  return { dialogs, asks, toasts }
}

/** The wizard, wired to a fixed model list and a scripted dialog. */
function wizard(models: readonly WizardModel[], answers: readonly (string | undefined)[]) {
  const { dialogs, asks, toasts } = fakeDialogs(answers)
  const pickPair = createPairing({ dialogs, catalogue: { models: async () => models } })
  return { pickPair, asks, toasts }
}

const GPT = model("openai", "gpt-5.6-sol")
const LUNA = model("openai", "gpt-5.6-luna")
const CLAUDE = model("anthropic", "claude-opus-5-5")
/** Matches the "OpenCode Zen" preset's ids, so the preset branch is taken. */
const ZEN_LEAD = model("opencode", "claude-opus-5-5")
const ZEN_SIDEKICK = model("opencode", "gpt-5.6-luna")

// --- the step plan -----------------------------------------------------------

describe("step plan", () => {
  it("a fitting preset asks only the two effort selects", async () => {
    const { pickPair, asks, toasts } = wizard([ZEN_LEAD, ZEN_SIDEKICK], ["OpenCode Zen", "max", "high"])

    const result = await pickPair()

    assert.equal(asks.length, 3)
    assert.equal(asks[0]?.title, "Fusion 0/4 · Preset")
    assert.equal(asks[1]?.title, "Fusion 2/4 · Lead effort (claude-opus-5-5 name)")
    assert.equal(asks[2]?.title, "Fusion 4/4 · Sidekick effort (gpt-5.6-luna name)")
    assert.deepEqual(result?.pair, {
      lead: { providerID: "opencode", modelID: "claude-opus-5-5", variant: "max" },
      sidekick: { providerID: "opencode", modelID: "gpt-5.6-luna", variant: "high" },
    })
    // A fitting preset raises no warning.
    assert.deepEqual(result?.warnings, [])
    assert.deepEqual(toasts, [])
  })

  it("a preset that does not fit warns, then walks four selects", async () => {
    // No model matches the "OpenCode Zen" ids at this location.
    const { pickPair, asks, toasts } = wizard([GPT, LUNA], ["OpenCode Zen", "openai|gpt-5.6-sol", "high", "openai|gpt-5.6-luna", "max"])

    const result = await pickPair()

    assert.deepEqual(asks.map((ask) => ask.title), [
      "Fusion 0/4 · Preset",
      "Fusion 1/4 · Lead model",
      "Fusion 2/4 · Lead effort",
      "Fusion 3/4 · Sidekick model",
      "Fusion 4/4 · Sidekick effort",
    ])
    assert.equal(toasts.length, 1)
    assert.match(toasts[0]?.message ?? "", /preset "OpenCode Zen" has no matching models here/)
    assert.deepEqual(result?.pair, {
      lead: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
      sidekick: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "max" },
    })
  })

  it("Custom from the first select walks four selects without a warning", async () => {
    const { pickPair, asks, toasts } = wizard([CLAUDE, LUNA], ["Custom", "anthropic|claude-opus-5-5", "max", "openai|gpt-5.6-luna", "high"])

    const result = await pickPair()

    assert.equal(asks.length, 5)
    assert.equal(asks[1]?.title, "Fusion 1/4 · Lead model")
    // "Custom" carries no provider, so the no-fit warning is not raised for it.
    assert.deepEqual(toasts, [])
    assert.deepEqual(result?.pair, {
      lead: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "max" },
      sidekick: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
    })
  })

  it("an empty catalogue toasts and returns undefined without asking anything", async () => {
    const { pickPair, asks, toasts } = wizard([], [])

    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 0)
    assert.match(toasts[0]?.message ?? "", /no models available at this location/)
  })
})

// --- cancellation ------------------------------------------------------------

describe("cancellation", () => {
  it("returns undefined when the preset select is cancelled", async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], [undefined])
    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 1)
  })

  it("returns undefined when a lead model select is cancelled", async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], ["Custom", undefined])
    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 2)
  })

  it("returns undefined when a lead effort select is cancelled", async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], ["Custom", "openai|gpt-5.6-sol", undefined])
    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 3)
  })

  it("returns undefined when a sidekick model select is cancelled", async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], [
      "Custom",
      "openai|gpt-5.6-sol",
      "high",
      undefined,
    ])
    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 4)
  })

  it("returns undefined when a sidekick effort select is cancelled", async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], [
      "Custom",
      "openai|gpt-5.6-sol",
      "high",
      "openai|gpt-5.6-luna",
      undefined,
    ])
    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 5)
  })

  it("returns undefined when a preset-path effort select is cancelled", async () => {
    const { pickPair, asks } = wizard([ZEN_LEAD, ZEN_SIDEKICK], ["OpenCode Zen", undefined])
    assert.equal(await pickPair(), undefined)
    assert.equal(asks.length, 2)
  })
})

// --- the effort rule ---------------------------------------------------------

describe("effort", () => {
  it("skips the effort select for a model with no variants and lands the default", async () => {
    const plain = model("opencode", "claude-opus-5-5", { variants: [] })
    const plainSidekick = model("opencode", "gpt-5.6-luna", { variants: [] })
    const { pickPair, asks } = wizard([plain, plainSidekick], ["OpenCode Zen"])

    const result = await pickPair()

    // Only the preset select: neither model has a variant to choose.
    assert.equal(asks.length, 1)
    // The model default leaves the variant key off entirely.
    assert.deepEqual(result?.pair, {
      lead: { providerID: "opencode", modelID: "claude-opus-5-5" },
      sidekick: { providerID: "opencode", modelID: "gpt-5.6-luna" },
    })
    assert.equal("variant" in (result?.pair.lead ?? {}), false)
  })

  it('the model default ("") is what the effort options list first, and leaves variant off', async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], ["Custom", "openai|gpt-5.6-sol", "", "openai|gpt-5.6-luna", ""])

    const result = await pickPair()

    // The effort rows offer the default plus one row per variant.
    const leadEffortOptions = asks[2]?.options ?? []
    assert.equal(leadEffortOptions[0]?.value, "")
    assert.deepEqual(leadEffortOptions.map((option) => option.value), ["", "high", "max"])
    assert.equal("variant" in (result?.pair.lead ?? {}), false)
    assert.equal("variant" in (result?.pair.sidekick ?? {}), false)
  })

  it("a chosen variant round-trips onto the returned model ref", async () => {
    const { pickPair } = wizard([GPT, LUNA], ["Custom", "openai|gpt-5.6-sol", "max", "openai|gpt-5.6-luna", "high"])
    const result = await pickPair()

    assert.deepEqual(result?.pair.lead, { providerID: "openai", modelID: "gpt-5.6-sol", variant: "max" })
    assert.deepEqual(result?.pair.sidekick, { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" })
  })
})

// --- prefill -----------------------------------------------------------------

describe("prefill", () => {
  const current: { lead?: ModelRef; sidekick?: ModelRef } = {
    lead: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "max" },
    sidekick: { providerID: "openai", modelID: "gpt-5.6-luna" },
  }

  it("the current model's key and variant reach the model and effort selects", async () => {
    const { pickPair, asks } = wizard([GPT, LUNA], ["Custom", "openai|gpt-5.6-sol", "high", "openai|gpt-5.6-luna", "high"])

    await pickPair(current)

    // Step 1 prefills the lead's model key.
    assert.equal(asks[1]?.current, "openai|gpt-5.6-sol")
    // Step 2 prefills the lead's variant, because the model is the same one.
    assert.equal(asks[2]?.current, "max")
    // The sidekick was picked with no variant, so its effort select starts at the default.
    assert.equal(asks[3]?.current, "openai|gpt-5.6-luna")
    assert.equal(asks[4]?.current, "")
  })

  it("does not prefill the effort when the current pair names a different model", async () => {
    const { pickPair, asks } = wizard([CLAUDE, LUNA], [
      "Custom",
      "anthropic|claude-opus-5-5",
      "high",
      "openai|gpt-5.6-luna",
      "high",
    ])

    await pickPair(current)

    // The lead model is not the prefilled one, so no stale variant is offered.
    assert.equal(asks[1]?.current, "openai|gpt-5.6-sol")
    assert.equal(asks[2]?.current, "")
  })

  it("prefills the model select in the preset path's effort step too", async () => {
    const { pickPair, asks } = wizard([ZEN_LEAD, ZEN_SIDEKICK], ["OpenCode Zen", "max", "high"])

    await pickPair({ lead: { providerID: "opencode", modelID: "claude-opus-5-5", variant: "max" } })

    assert.equal(asks[1]?.current, "max")
  })
})

// --- warnings ----------------------------------------------------------------

describe("warnings", () => {
  it("warns when lead and sidekick land in the same family", async () => {
    const { pickPair } = wizard([GPT, LUNA], ["Custom", "openai|gpt-5.6-sol", "high", "openai|gpt-5.6-luna", "high"])

    const result = await pickPair()

    assert.deepEqual(result?.warnings, ["same family (openai): no independent cross-vendor review"])
  })

  it("returns no warning across families", async () => {
    const { pickPair } = wizard([CLAUDE, LUNA], [
      "Custom",
      "anthropic|claude-opus-5-5",
      "high",
      "openai|gpt-5.6-luna",
      "high",
    ])

    const result = await pickPair()

    assert.deepEqual(result?.warnings, [])
  })
})

// --- row builders ------------------------------------------------------------

describe("model rows", () => {
  it("shows provider, context size, price and the context tier count", async () => {
    const priced = model("openai", "gpt-5.6-sol", {
      limit: { context: 200_000 },
      cost: [
        { input: 2.5, output: 10, cache: { read: 0.25, write: 3.75 } },
        { tier: { type: "context", size: 100_000 }, input: 5, output: 20, cache: { read: 0.5, write: 5 } },
      ],
    })
    const { pickPair, asks } = wizard([priced, LUNA], ["Custom"])

    await pickPair()

    const row = asks[1]?.options.find((option) => option.value === "openai|gpt-5.6-sol")
    assert.equal(row?.title, "gpt-5.6-sol name")
    assert.equal(row?.category, "openai")
    // The untiered entry is what the row quotes, with the tier count alongside.
    assert.equal(row?.description, "openai · 200k ctx · $2.5/M in · $10/M out · cache $0.25/$3.75 · +1 context tiers")
  })

  it("says so when a model has no price data or no context limit", async () => {
    const bare = model("openai", "bare")
    const { pickPair, asks } = wizard([bare, LUNA], ["Custom"])

    await pickPair()

    const row = asks[1]?.options.find((option) => option.value === "openai|bare")
    assert.equal(row?.description, "openai · unknown ctx · no price data")
  })
})
