/**
 * The prompt-footer status sentence.
 *
 * Two pure pieces the JSX slot used to hold: whether the session in view is a
 * lead session at all, and what the line says. Free of host types — the caller
 * passes the session's agent in — so both are testable on plain Node.
 */
import { describeModelName, type FusionPair } from "./pair.ts"

export type StatusLineState = {
  readonly pair: FusionPair | undefined
  /** The agent id the lead runs as; a session on any other agent is not ours. */
  readonly leadAgent: string
}

/** Whether the status line belongs on this session: it exists, and runs the lead. */
export function isLeadSession(state: StatusLineState, sessionID: string | undefined, sessionAgent: string | undefined): boolean {
  return sessionID !== undefined && sessionAgent === state.leadAgent
}

/**
 * The line itself. With no pair yet it prompts for `/fusion`; otherwise it names
 * the pair, with the running suffix when this lead's sidekick is working.
 */
export function statusText(state: StatusLineState, sessionID: string | undefined, running: boolean): string {
  const pair = state.pair
  if (!pair) return "fusion · no pair (run /fusion)"
  const suffix = sessionID !== undefined && running ? " · sidekick running" : ""
  return `fusion ${describeModelName(pair.lead)} → ${describeModelName(pair.sidekick)}${suffix}`
}
