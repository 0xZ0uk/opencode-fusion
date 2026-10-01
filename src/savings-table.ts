import { money } from "./costs.ts"
import { missingPricingNote, provenanceNote, skippedNote, type SavingsSnapshot } from "./savings.ts"

export interface SavingsTableModel {
  readonly label: string
  readonly value: string
}

export interface SavingsTableRow {
  readonly label: string
  readonly lead: string
  readonly sidekick: string
}

export interface SavingsTableSummaryRow {
  readonly label: string
  readonly value: string
  readonly highlight?: boolean
}

export interface SavingsTable {
  readonly models: readonly SavingsTableModel[]
  readonly usage: readonly SavingsTableRow[]
  readonly summary: readonly SavingsTableSummaryRow[]
  readonly notes: readonly string[]
}

export function savingsTable(snapshot: SavingsSnapshot): SavingsTable {
  const models: SavingsTableModel[] = [
    { label: "Lead", value: snapshot.lead.model },
    { label: "Sidekick", value: snapshot.sidekick.model },
  ]

  const usage: SavingsTableRow[] = [
    { label: "Sessions", lead: "1", sidekick: snapshot.sidekick.sessions.toLocaleString() },
    {
      label: "Input tokens",
      lead: snapshot.lead.tokens.input.toLocaleString(),
      sidekick: snapshot.sidekick.tokens.input.toLocaleString(),
    },
    {
      label: "Output tokens",
      lead: snapshot.lead.tokens.output.toLocaleString(),
      sidekick: snapshot.sidekick.tokens.output.toLocaleString(),
    },
    {
      label: "Reasoning tokens",
      lead: snapshot.lead.tokens.reasoning.toLocaleString(),
      sidekick: snapshot.sidekick.tokens.reasoning.toLocaleString(),
    },
    { label: "Billed", lead: money(snapshot.lead.cost), sidekick: money(snapshot.sidekick.cost) },
  ]

  const summary: SavingsTableSummaryRow[] = [{ label: "Total billed", value: money(snapshot.totalBilled) }]
  if (snapshot.atLeadRates !== undefined) {
    summary.push({ label: "Sidekick at lead rates", value: money(snapshot.atLeadRates) })
  }
  if (snapshot.estimatedSaving !== undefined) {
    summary.push({ label: "Estimated savings", value: money(snapshot.estimatedSaving), highlight: true })
  }

  const notes: string[] = []
  if (snapshot.skipped > 0) notes.push(skippedNote(snapshot.skipped))
  if (snapshot.atLeadRates === undefined) notes.push(missingPricingNote)
  notes.push(provenanceNote(snapshot.pricingSource))

  return { models, usage, summary, notes }
}
