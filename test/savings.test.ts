import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ModelCost } from "@opencode/client"
import { savingsReport, type SessionReader } from "../src/savings.ts"
import { createCosts } from "../src/costs.ts"
import type { FusionPair } from "../src/pair.ts"

const BASE: ModelCost = { input: 10, output: 20, cache: { read: 1, write: 5 } }
const LARGE: ModelCost = {
  tier: { type: "context", size: 100_000 },
  input: 20,
  output: 40,
  cache: { read: 2, write: 10 },
}
const XLARGE: ModelCost = {
  tier: { type: "context", size: 500_000 },
  input: 30,
  output: 60,
  cache: { read: 3, write: 15 },
}
const COSTS = [BASE, LARGE, XLARGE]

const PAIR: FusionPair = {
  lead: { providerID: "leadco", modelID: "big", variant: "high" },
  sidekick: { providerID: "cheap", modelID: "small" },
  leadAgent: "fusion",
  sidekickAgent: "sidekick",
}

const usage = (input: number, output = 0, reasoning = 0, read = 0, write = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

const msg = (tokens: unknown, type = "assistant") => ({ type, tokens })

type Page = { data: { type: string; tokens?: unknown }[]; next?: string | null }

const makeReader = (opts: {
  sidekicks?: readonly string[] | Error
  sessions?: Record<string, { cost: number; tokens?: unknown } | Error>
  pages?: Record<string, Page[] | Error>
  pricing?: { costs: readonly ModelCost[]; source?: string } | Error
}) => {
  const calls = {
    getSession: [] as string[],
    sidekicks: 0,
    pages: [] as { id: string; cursor?: string }[],
    pricing: 0,
  }
  const reader: SessionReader = {
    sessionID: "lead-1",
    getSession: async (id) => {
      calls.getSession.push(id)
      const session = opts.sessions?.[id]
      if (session instanceof Error) throw session
      if (!session) throw new Error(`no session ${id}`)
      return session as Awaited<ReturnType<SessionReader["getSession"]>>
    },
    sidekickSessions: async () => {
      calls.sidekicks += 1
      if (opts.sidekicks instanceof Error) throw opts.sidekicks
      return opts.sidekicks ?? []
    },
    listAssistantMessages: async (id, cursor) => {
      calls.pages.push({ id, cursor })
      const pages = opts.pages?.[id]
      if (pages instanceof Error) throw pages
      const index = calls.pages.filter((call) => call.id === id).length - 1
      const page = pages?.[Math.min(index, (pages?.length ?? 1) - 1)]
      return {
        data: (page?.data ?? []) as Awaited<ReturnType<SessionReader["listAssistantMessages"]>>["data"],
        cursor: { next: page?.next },
      }
    },
    leadPricing: async () => {
      calls.pricing += 1
      if (opts.pricing instanceof Error) throw opts.pricing
      return opts.pricing ?? { costs: [] }
    },
  }
  return { reader, calls }
}

describe("savingsReport", () => {
  it("reports the missing pair without touching the reader", async () => {
    const { reader, calls } = makeReader({})
    assert.deepEqual(await savingsReport(undefined, reader), ["no pair picked yet — run /fusion"])
    assert.equal(calls.getSession.length, 0)
    assert.equal(calls.sidekicks, 0)
    assert.equal(calls.pages.length, 0)
    assert.equal(calls.pricing, 0)
  })

  it("builds the full report from sessions and paginated messages", async () => {
    const { reader, calls } = makeReader({
      sidekicks: ["s1", "s2"],
      sessions: {
        "lead-1": { cost: 2, tokens: usage(10, 20, 30) },
        s1: { cost: 1, tokens: usage(170_000, 15_000, 10_000, 80_000, 20_000) },
        s2: { cost: 2, tokens: usage(600_000) },
      },
      pages: {
        s1: [
          { data: [msg(usage(50_000, 10_000, 5_000)), msg(usage(999_999), "user")], next: "p2" },
          { data: [msg(usage(120_000, 5_000, 5_000, 80_000, 20_000))], next: null },
        ],
        s2: [{ data: [msg(usage(600_000))] }],
      },
      pricing: { costs: COSTS, source: "OpenCode catalogue" },
    })
    const lines = await savingsReport(PAIR, reader)
    assert.deepEqual(lines, [
      "lead     leadco/big#high",
      `         ${(10).toLocaleString()} in · ${(20).toLocaleString()} out · ${(30).toLocaleString()} reasoning · billed $2.0000`,
      "sidekick cheap/small · 2 sessions",
      `         ${(770_000).toLocaleString()} in · ${(15_000).toLocaleString()} out · ${(10_000).toLocaleString()} reasoning · billed $3.0000`,
      "",
      "total billed: $5.0000",
      "same sidekick work at lead rates: $21.9600",
      "estimated saving: $18.9600",
      "",
      "the lead-rate figure is priced per sidekick message from OpenCode catalogue (context tier per message, reasoning at output rate); billed figures are OpenCode's recorded session costs",
    ])
    assert.deepEqual(calls.pages, [
      { id: "s1", cursor: undefined },
      { id: "s1", cursor: "p2" },
      { id: "s2", cursor: undefined },
    ])
  })

  it("labels the pricing source when it is models.dev", async () => {
    const { reader } = makeReader({
      sidekicks: [],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) } },
      pricing: { costs: COSTS, source: "models.dev" },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /models\.dev/)
  })

  it("reports zero sessions when there are no sidekicks", async () => {
    const { reader } = makeReader({
      sidekicks: [],
      sessions: { "lead-1": { cost: 2, tokens: usage(10, 20, 30) } },
      pricing: { costs: COSTS },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /· 0 sessions/)
    assert.match(report, /total billed: \$2\.0000/)
    assert.match(report, /same sidekick work at lead rates: \$0\.0000/)
    assert.match(report, /estimated saving: \$0\.0000/)
  })

  it("uses the singular session label and clamps a negative saving to zero", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: {
        "lead-1": { cost: 0, tokens: usage(0) },
        s1: { cost: 5, tokens: usage(1_000) },
      },
      pages: { s1: [{ data: [msg(usage(1_000))] }] },
      pricing: { costs: COSTS },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /· 1 session\b/)
    assert.doesNotMatch(report, /1 sessions/)
    assert.match(report, /estimated saving: \$0\.0000/)
  })

  it("shows billed totals but no saving when the lead has no price data", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: {
        "lead-1": { cost: 2, tokens: usage(10) },
        s1: { cost: 1, tokens: usage(1_000) },
      },
      pages: { s1: [{ data: [msg(usage(1_000))] }] },
      pricing: { costs: [] },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /total billed: \$3\.0000/)
    assert.match(report, /no price data for the lead model — cannot estimate the saving/)
    assert.doesNotMatch(report, /estimated saving:/)
  })

  it("treats missing token blocks as zeros", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": { cost: 1 }, s1: { cost: 1 } },
      pages: { s1: [{ data: [{ type: "assistant" }] }] },
      pricing: { costs: COSTS },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /0 in · 0 out · 0 reasoning · billed \$1\.0000/)
    assert.match(report, /same sidekick work at lead rates: \$0\.0000/)
  })

  it("reads duplicated sidekick ids only once", async () => {
    const { reader, calls } = makeReader({
      sidekicks: ["s1", "s1", "s1"],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) }, s1: { cost: 1, tokens: usage(1_000) } },
      pages: { s1: [{ data: [msg(usage(1_000))] }] },
      pricing: { costs: COSTS },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /· 1 session\b/)
    assert.deepEqual(calls.getSession.filter((id) => id === "s1"), ["s1"])
    assert.equal(calls.pages.length, 1)
  })

  it("omits unreadable sidekick sessions and says so", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1", "s2"],
      sessions: {
        "lead-1": { cost: 2, tokens: usage(0) },
        s1: { cost: 1, tokens: usage(1_000) },
        s2: new Error("gone"),
      },
      pages: { s1: [{ data: [msg(usage(120_000, 5_000, 5_000, 80_000, 20_000)), msg(usage(50_000, 10_000, 5_000))] }] },
      pricing: { costs: COSTS },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /· 1 session\b/)
    assert.match(report, /total billed: \$3\.0000/)
    assert.match(report, /same sidekick work at lead rates: \$3\.9600/)
    assert.match(report, /estimated saving: \$2\.9600/)
    assert.match(report, /1 unavailable sidekick session omitted; totals cover readable sessions only/)
  })

  it("propagates a message page failure", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) }, s1: { cost: 1, tokens: usage(0) } },
      pages: { s1: new Error("boom") },
      pricing: { costs: COSTS },
    })
    await assert.rejects(savingsReport(PAIR, reader), /boom/)
  })

  it("propagates a lead session read failure", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": new Error("lead gone"), s1: { cost: 1, tokens: usage(0) } },
      pricing: { costs: COSTS },
    })
    await assert.rejects(savingsReport(PAIR, reader), /lead gone/)
  })

  it("propagates a sidekick registry failure", async () => {
    const { reader } = makeReader({
      sidekicks: new Error("registry down"),
      sessions: { "lead-1": { cost: 0, tokens: usage(0) } },
      pricing: { costs: COSTS },
    })
    await assert.rejects(savingsReport(PAIR, reader), /registry down/)
  })

  it("propagates a lead pricing failure", async () => {
    const { reader } = makeReader({
      sidekicks: [],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) } },
      pricing: new Error("catalogue down"),
    })
    await assert.rejects(savingsReport(PAIR, reader), /catalogue down/)
  })

  it("follows an empty page that still has a next cursor", async () => {
    const { reader, calls } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) }, s1: { cost: 1, tokens: usage(0) } },
      pages: {
        s1: [{ data: [], next: "p2" }, { data: [msg(usage(50_000, 10_000, 5_000))] }],
      },
      pricing: { costs: COSTS },
    })
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /same sidekick work at lead rates: \$0\.8000/)
    assert.equal(calls.pages.length, 2)
  })

  it("stops on an undefined terminal cursor", async () => {
    const { reader, calls } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) }, s1: { cost: 1, tokens: usage(0) } },
      pages: { s1: [{ data: [msg(usage(1_000))] }] },
      pricing: { costs: COSTS },
    })
    await savingsReport(PAIR, reader)
    assert.equal(calls.pages.length, 1)
  })

  it("rejects a repeated cursor instead of looping", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) }, s1: { cost: 1, tokens: usage(0) } },
      pages: { s1: [{ data: [], next: "a" }, { data: [], next: "a" }] },
      pricing: { costs: COSTS },
    })
    await assert.rejects(savingsReport(PAIR, reader), /repeated message cursor/)
  })

  it("rejects an A->B->A cursor cycle", async () => {
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: { "lead-1": { cost: 0, tokens: usage(0) }, s1: { cost: 1, tokens: usage(0) } },
      pages: { s1: [{ data: [], next: "b" }, { data: [], next: "a" }, { data: [], next: "b" }] },
      pricing: { costs: COSTS },
    })
    await assert.rejects(savingsReport(PAIR, reader), /repeated message cursor/)
  })

  it("handles very large message histories without a RangeError", async () => {
    const TOTAL = 131_000
    const reader: SessionReader = {
      sessionID: "lead-1",
      getSession: async (id) => ({ cost: 0, tokens: usage(id === "bulk" ? TOTAL : 0) }),
      sidekickSessions: async () => ["bulk"],
      listAssistantMessages: async (_id, cursor) => {
        const offset = cursor ? Number(cursor) : 0
        const count = Math.min(100, TOTAL - offset)
        const next = offset + count < TOTAL ? String(offset + count) : null
        return {
          data: Array.from({ length: count }, () => msg(usage(1))) as Awaited<
            ReturnType<SessionReader["listAssistantMessages"]>
          >["data"],
          cursor: { next },
        }
      },
      leadPricing: async () => ({ costs: [BASE] }),
    }
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /same sidekick work at lead rates: \$1\.3100/)
    assert.match(report, /estimated saving: \$1\.3100/)
  })

  it("prices the report through a real model-pricing resolver backed by models.dev data", async () => {
    const resolve = createCosts(async () => [], async () => ({
      leadco: {
        models: {
          big: {
            cost: {
              input: 2.5,
              output: 10,
              tiers: [{ tier: { type: "context", size: 272_000 }, input: 5, output: 20 }],
            },
          },
        },
      },
    }))
    const { reader } = makeReader({
      sidekicks: ["s1"],
      sessions: {
        "lead-1": { cost: 2, tokens: usage(0) },
        s1: { cost: 1, tokens: usage(550_000) },
      },
      pages: { s1: [{ data: [msg(usage(250_000)), msg(usage(300_000))] }] },
    })
    reader.leadPricing = resolve
    const report = (await savingsReport(PAIR, reader)).join("\n")
    assert.match(report, /total billed: \$3\.0000/)
    assert.match(report, /same sidekick work at lead rates: \$2\.1250/)
    assert.match(report, /estimated saving: \$1\.1250/)
    assert.match(report, /models\.dev/)
  })
})
