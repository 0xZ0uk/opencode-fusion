import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { savingsTable } from "../src/savings-table.ts"
import { missingPricingNote, type SavingsSnapshot } from "../src/savings.ts"
import type { Tokens } from "../src/costs.ts"

const tokens = (input: number, output = 0, reasoning = 0): Tokens => ({
  input,
  output,
  reasoning,
  cacheRead: 0,
  cacheWrite: 0,
})

const SNAPSHOT: SavingsSnapshot = {
  lead: { model: "leadco/big#high", tokens: tokens(10, 20, 30), cost: 2 },
  sidekick: { model: "cheap/small", tokens: tokens(770_000, 15_000, 10_000), cost: 3, sessions: 2 },
  skipped: 0,
  totalBilled: 5,
  atLeadRates: 21.96,
  estimatedSaving: 18.96,
  pricingSource: "OpenCode catalogue",
}

describe("savingsTable", () => {
  it("labels the models and keeps the full provider/model/variant refs", () => {
    const table = savingsTable({
      ...SNAPSHOT,
      lead: { ...SNAPSHOT.lead, model: "a-quite-long-provider-name/some-very-long-model-id#ultra-variant" },
      sidekick: { ...SNAPSHOT.sidekick, model: "another-provider/another-long-model#max" },
    })
    assert.deepEqual(table.models, [
      { label: "Lead", value: "a-quite-long-provider-name/some-very-long-model-id#ultra-variant" },
      { label: "Sidekick", value: "another-provider/another-long-model#max" },
    ])
  })

  it("lays out the Metric/Lead/Sidekick comparison rows", () => {
    const table = savingsTable(SNAPSHOT)
    assert.deepEqual(table.usage, [
      { label: "Sessions", lead: "1", sidekick: "2" },
      { label: "Input tokens", lead: "10", sidekick: (770_000).toLocaleString() },
      { label: "Output tokens", lead: "20", sidekick: (15_000).toLocaleString() },
      { label: "Reasoning tokens", lead: "30", sidekick: (10_000).toLocaleString() },
      { label: "Billed", lead: "$2.0000", sidekick: "$3.0000" },
    ])
  })

  it("formats numbers with toLocaleString", () => {
    const table = savingsTable({
      ...SNAPSHOT,
      sidekick: { ...SNAPSHOT.sidekick, tokens: tokens(1_234_567), sessions: 1234 },
    })
    const input = table.usage.find((row) => row.label === "Input tokens")
    assert.equal(input?.sidekick, (1_234_567).toLocaleString())
    const sessions = table.usage.find((row) => row.label === "Sessions")
    assert.equal(sessions?.sidekick, (1234).toLocaleString())
  })

  it("shows the cost summary with the saving highlighted", () => {
    const table = savingsTable(SNAPSHOT)
    assert.deepEqual(table.summary, [
      { label: "Total billed", value: "$5.0000" },
      { label: "Sidekick at lead rates", value: "$21.9600" },
      { label: "Estimated savings", value: "$18.9600", highlight: true },
    ])
  })

  it("renders real zeros rather than dropping rows", () => {
    const table = savingsTable({
      lead: { model: "leadco/big", tokens: tokens(0), cost: 0 },
      sidekick: { model: "cheap/small", tokens: tokens(0), cost: 0, sessions: 0 },
      skipped: 0,
      totalBilled: 0,
      atLeadRates: 0,
      estimatedSaving: 0,
      pricingSource: "OpenCode catalogue",
    })
    assert.deepEqual(table.usage.find((row) => row.label === "Sessions"), {
      label: "Sessions",
      lead: "1",
      sidekick: "0",
    })
    assert.deepEqual(table.summary, [
      { label: "Total billed", value: "$0.0000" },
      { label: "Sidekick at lead rates", value: "$0.0000" },
      { label: "Estimated savings", value: "$0.0000", highlight: true },
    ])
  })

  it("omits the lead-rate rows and adds the missing-price note without pricing", () => {
    const table = savingsTable({
      lead: { model: "leadco/big", tokens: tokens(10), cost: 2 },
      sidekick: { model: "cheap/small", tokens: tokens(1_000), cost: 1, sessions: 1 },
      skipped: 0,
      totalBilled: 3,
      pricingSource: "OpenCode catalogue",
    })
    assert.deepEqual(table.summary, [{ label: "Total billed", value: "$3.0000" }])
    assert.ok(table.notes.includes(missingPricingNote))
  })

  it("keeps the skipped-session note, singular and plural", () => {
    const one = savingsTable({ ...SNAPSHOT, skipped: 1 })
    assert.ok(one.notes.includes("1 unavailable sidekick session omitted; totals cover readable sessions only"))
    const two = savingsTable({ ...SNAPSHOT, skipped: 2 })
    assert.ok(two.notes.includes("2 unavailable sidekick sessions omitted; totals cover readable sessions only"))
  })

  it("always carries the pricing-source provenance note", () => {
    const table = savingsTable(SNAPSHOT)
    assert.ok(
      table.notes.includes(
        "the lead-rate figure is priced per sidekick message from OpenCode catalogue (context tier per message, reasoning at output rate); billed figures are OpenCode's recorded session costs",
      ),
    )
  })
})
