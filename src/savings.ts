import type { TokenUsageInfo } from "@opencode/client"
import { describeModelRef, type FusionPair, type ModelRef } from "./pair.ts"
import {
  EMPTY_TOKENS,
  addTokens,
  money,
  priceMessages,
  sourceOf,
  tokensOf,
  type CostCard,
  type Tokens,
} from "./costs.ts"

export interface SessionReader {
  readonly sessionID: string
  getSession(sessionID: string): Promise<{ cost: number; tokens?: TokenUsageInfo }>
  sidekickSessions(): Promise<readonly string[]>
  listAssistantMessages(
    sessionID: string,
    cursor?: string,
  ): Promise<{ data: readonly { type: string; tokens?: TokenUsageInfo }[]; cursor: { next?: string | null } }>
  leadPricing(ref: ModelRef): Promise<CostCard>
}

const formatTokens = (tokens: Tokens): string =>
  `${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out · ${tokens.reasoning.toLocaleString()} reasoning`

async function collectMessages(reader: SessionReader, sessionID: string): Promise<Tokens[]> {
  const perMessage: Tokens[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await reader.listAssistantMessages(sessionID, cursor)
    for (const message of page.data) {
      if (message.type === "assistant") perMessage.push(tokensOf(message.tokens))
    }
    const next = page.cursor?.next
    if (next === undefined || next === null || next === "") break
    if (seen.has(next)) throw new Error("repeated message cursor")
    seen.add(next)
    cursor = next
  }
  return perMessage
}

export async function savingsReport(pair: FusionPair | undefined, reader: SessionReader): Promise<string[]> {
  if (!pair) return ["no pair picked yet — run /fusion"]

  const [sidekickIDs, leadSession, pricing] = await Promise.all([
    reader.sidekickSessions(),
    reader.getSession(reader.sessionID),
    reader.leadPricing(pair.lead),
  ])

  let sidekickCost = 0
  let sidekickTokens = EMPTY_TOKENS
  let sessions = 0
  let skipped = 0
  const perMessage: Tokens[] = []
  for (const sidekickID of new Set(sidekickIDs)) {
    let sidekickSession
    try {
      sidekickSession = await reader.getSession(sidekickID)
    } catch {
      skipped += 1
      continue
    }
    sessions += 1
    sidekickCost += sidekickSession.cost
    sidekickTokens = addTokens(sidekickTokens, tokensOf(sidekickSession.tokens))
    for (const tokens of await collectMessages(reader, sidekickID)) {
      perMessage.push(tokens)
    }
  }

  const costs = pricing.costs
  const lines = [
    `lead     ${describeModelRef(pair.lead)}`,
    `         ${formatTokens(tokensOf(leadSession.tokens))} · billed ${money(leadSession.cost)}`,
    `sidekick ${describeModelRef(pair.sidekick)} · ${sessions} session${sessions === 1 ? "" : "s"}`,
    `         ${formatTokens(sidekickTokens)} · billed ${money(sidekickCost)}`,
  ]
  if (skipped > 0) {
    lines.push(
      `${skipped} unavailable sidekick session${skipped === 1 ? "" : "s"} omitted; totals cover readable sessions only`,
    )
  }
  lines.push("", `total billed: ${money(leadSession.cost + sidekickCost)}`)
  if (costs.length > 0) {
    const atLeadRates = priceMessages(perMessage, costs)
    lines.push(
      `same sidekick work at lead rates: ${money(atLeadRates)}`,
      `estimated saving: ${money(Math.max(atLeadRates - sidekickCost, 0))}`,
    )
  } else {
    lines.push("no price data for the lead model — cannot estimate the saving")
  }
  lines.push(
    "",
    `the lead-rate figure is priced per sidekick message from ${sourceOf(pricing)} (context tier per message, reasoning at output rate); billed figures are OpenCode's recorded session costs`,
  )
  return lines
}
