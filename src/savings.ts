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

export interface SavingsSnapshot {
  readonly lead: { readonly model: string; readonly tokens: Tokens; readonly cost: number }
  readonly sidekick: {
    readonly model: string
    readonly tokens: Tokens
    readonly cost: number
    readonly sessions: number
  }
  readonly skipped: number
  readonly totalBilled: number
  readonly atLeadRates?: number
  readonly estimatedSaving?: number
  readonly pricingSource: string
}

export const skippedNote = (skipped: number): string =>
  `${skipped} unavailable sidekick session${skipped === 1 ? "" : "s"} omitted; totals cover readable sessions only`

export const missingPricingNote = "no price data for the lead model — cannot estimate the saving"

export const provenanceNote = (source: string): string =>
  `the lead-rate figure is priced per sidekick message from ${source} (context tier per message, reasoning at output rate); billed figures are OpenCode's recorded session costs`

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

export async function collectSavings(
  pair: FusionPair | undefined,
  reader: SessionReader,
): Promise<SavingsSnapshot | undefined> {
  if (!pair) return undefined

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

  const atLeadRates = pricing.costs.length > 0 ? priceMessages(perMessage, pricing.costs) : undefined
  return {
    lead: { model: describeModelRef(pair.lead), tokens: tokensOf(leadSession.tokens), cost: leadSession.cost },
    sidekick: {
      model: describeModelRef(pair.sidekick),
      tokens: sidekickTokens,
      cost: sidekickCost,
      sessions,
    },
    skipped,
    totalBilled: leadSession.cost + sidekickCost,
    atLeadRates,
    estimatedSaving: atLeadRates === undefined ? undefined : Math.max(atLeadRates - sidekickCost, 0),
    pricingSource: sourceOf(pricing),
  }
}

export async function savingsReport(pair: FusionPair | undefined, reader: SessionReader): Promise<string[]> {
  const snapshot = await collectSavings(pair, reader)
  if (!snapshot) return ["no pair picked yet — run /fusion"]

  const lines = [
    `lead     ${snapshot.lead.model}`,
    `         ${formatTokens(snapshot.lead.tokens)} · billed ${money(snapshot.lead.cost)}`,
    `sidekick ${snapshot.sidekick.model} · ${snapshot.sidekick.sessions} session${snapshot.sidekick.sessions === 1 ? "" : "s"}`,
    `         ${formatTokens(snapshot.sidekick.tokens)} · billed ${money(snapshot.sidekick.cost)}`,
  ]
  if (snapshot.skipped > 0) {
    lines.push(skippedNote(snapshot.skipped))
  }
  lines.push("", `total billed: ${money(snapshot.totalBilled)}`)
  if (snapshot.atLeadRates !== undefined) {
    lines.push(
      `same sidekick work at lead rates: ${money(snapshot.atLeadRates)}`,
      `estimated saving: ${money(snapshot.estimatedSaving ?? 0)}`,
    )
  } else {
    lines.push(missingPricingNote)
  }
  lines.push("", provenanceNote(snapshot.pricingSource))
  return lines
}
