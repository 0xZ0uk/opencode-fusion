/**
 * Sidekick state, derived from the host's session list.
 *
 * A sidekick session is any session whose `metadata.fusionLeadSession` names the
 * lead — the marker `createSidekickSessions` writes at create time. "Live" means
 * not archived: an archived sidekick session is still listed by the host, it is
 * just one the plugin will not reuse.
 *
 * Pure and structural: no imports at all, so it loads under plain Node and the
 * TUI can hand it the host's own `SessionInfo[]` without an adapter type.
 */

/** The metadata key naming the lead a sidekick session belongs to. */
const LEAD_SESSION_KEY = "fusionLeadSession"

/** The structural slice of a host session this module reads. */
export type SidekickSession = {
  readonly id: string
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
  readonly time?: { readonly archived?: number | undefined } | undefined
  /** The host's run status for this session: "idle" or "running". */
  readonly status?: string | undefined
}

const liveOf = (session: SidekickSession, leadSessionID: string): boolean =>
  session.metadata?.[LEAD_SESSION_KEY] === leadSessionID && !session.time?.archived

/** This lead's live sidekick sessions, in the order the host lists them. */
export function sidekickSessions(sessions: readonly SidekickSession[], leadSessionID: string): string[] {
  return sessions.filter((session) => liveOf(session, leadSessionID)).map((session) => session.id)
}

/** Whether any of this lead's live sidekick sessions is running. */
export function sidekickRunning(sessions: readonly SidekickSession[], leadSessionID: string): boolean {
  return sessions.some((session) => liveOf(session, leadSessionID) && session.status === "running")
}
