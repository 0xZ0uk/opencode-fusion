/**
 * Sidekick session registry.
 *
 * Owns the persistent lead→current-sidekick mapping and the per-lead history of
 * every sidekick session ever created. Both maps double as an LRU: insertion
 * order is recency, and persistence prunes the oldest end of each to a cap.
 *
 * Storage comes in as a seam — `ctx.storage` in production, an in-memory fake
 * in tests. The persisted shapes are normalized and seeded on load; the
 * normalizers stay private here.
 *
 * Mutations change memory synchronously and return the promise of their
 * persistence write, so a caller that needs the write to land before moving on
 * can await it. Writes are serialized: each one snapshots the maps when its
 * turn comes, so rapid mutations cannot finish out of order or land stale
 * snapshots last.
 *
 * Type-only imports on purpose: no runtime dependency on `@opencode/*`.
 */

/** Lead session -> current sidekick session. Insertion order is recency. */
const CHILDREN_KEY = "sidekick-sessions"
/** Lead session -> every sidekick session created for it, oldest first. */
const SIDEKICK_HISTORY_KEY = "sidekick-history"
/** Cap on remembered lead→sidekick pairs; each map doubles as an LRU. */
const CHILDREN_CAP = 200

/** The slice of `ctx.storage` the registry needs; the host adapter owns the cast. */
export type SidekickStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export type SidekickRegistry = {
  /** The lead's current sidekick session, if one is remembered. Pure read — LRU recency is only touched by `record`. */
  current(leadSessionID: string): string | undefined
  /**
   * Set the lead's current sidekick session (LRU touch: delete + re-insert),
   * append it to history only when absent, and persist. The maps change
   * synchronously; the returned promise settles once the write lands.
   */
  record(leadSessionID: string, sidekickSessionID: string): Promise<void>
  /**
   * Drop the lead's current child mapping; history keeps the old sessions
   * reachable so per-session stats do not lose them. A no-op writes nothing.
   * Resolves once the change is persisted.
   */
  reset(leadSessionID: string): Promise<void>
  /**
   * Remove a session id everywhere — as a lead key, as a child value, and from
   * history lists (dropping emptied lists). Resolves to whether anything
   * changed; a no-op writes nothing.
   */
  forget(sessionID: string): Promise<boolean>
  /** The "current ∪ history" list the sidekicks RPC reports. */
  sessions(leadSessionID: string): string[]
}

type UnknownRecord = Record<string, unknown>

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined

function normalizeChildren(value: unknown): Record<string, string> {
  const record = asRecord(value) ?? {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) if (typeof entry === "string") out[key] = entry
  return out
}

function normalizeHistory(value: unknown): Record<string, string[]> {
  const record = asRecord(value) ?? {}
  const out: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (!Array.isArray(entry)) continue
    const list = entry.filter((item): item is string => typeof item === "string")
    if (list.length > 0) out[key] = list
  }
  return out
}

export async function createRegistry(storage: SidekickStorage): Promise<SidekickRegistry> {
  const children = new Map<string, string>(Object.entries(normalizeChildren(await storage.get(CHILDREN_KEY))))
  const history = new Map<string, string[]>(Object.entries(normalizeHistory(await storage.get(SIDEKICK_HISTORY_KEY))))
  // Seed: a remembered current child is reachable through history too.
  for (const [lead, sidekick] of children) {
    const list = history.get(lead)
    if (list === undefined) history.set(lead, [sidekick])
    else if (!list.includes(sidekick)) list.push(sidekick)
  }

  // Writes are serialized on this chain. A write snapshots the maps when its
  // turn comes, so a mutation queued behind an in-flight write cannot be
  // overwritten by it, and the last write to land always carries the newest
  // state.
  let writes: Promise<void> = Promise.resolve()

  /**
   * Prune both maps to the cap from the oldest end — synchronously, so readers
   * see the cap immediately — then queue the write.
   */
  const persist = (): Promise<void> => {
    while (children.size > CHILDREN_CAP) {
      const oldest = children.keys().next().value
      if (oldest === undefined) break
      children.delete(oldest)
    }
    while (history.size > CHILDREN_CAP) {
      const oldest = history.keys().next().value
      if (oldest === undefined) break
      history.delete(oldest)
    }
    const write = writes.then(async () => {
      await storage.set(CHILDREN_KEY, Object.fromEntries(children))
      await storage.set(SIDEKICK_HISTORY_KEY, Object.fromEntries(history))
    })
    // A failed write must not poison the chain; the caller awaiting it still
    // sees the rejection.
    writes = write.catch(() => {})
    return write
  }

  const current = (leadSessionID: string): string | undefined => children.get(leadSessionID)

  const record = (leadSessionID: string, sidekickSessionID: string): Promise<void> => {
    children.delete(leadSessionID)
    children.set(leadSessionID, sidekickSessionID)
    const list = history.get(leadSessionID)
    if (list === undefined) history.set(leadSessionID, [sidekickSessionID])
    else if (!list.includes(sidekickSessionID)) list.push(sidekickSessionID)
    return persist()
  }

  const reset = (leadSessionID: string): Promise<void> => {
    if (!children.delete(leadSessionID)) return Promise.resolve()
    return persist()
  }

  const forget = (sessionID: string): Promise<boolean> => {
    let removed = children.delete(sessionID)
    for (const [leadID, sidekickID] of [...children]) {
      if (sidekickID === sessionID) {
        children.delete(leadID)
        removed = true
      }
    }
    if (history.delete(sessionID)) removed = true
    for (const [leadID, list] of [...history]) {
      const kept = list.filter((id) => id !== sessionID)
      if (kept.length === list.length) continue
      if (kept.length === 0) history.delete(leadID)
      else history.set(leadID, kept)
      removed = true
    }
    if (!removed) return Promise.resolve(false)
    const persisted = persist().then(() => true)
    // Never let an ignored `forget` promise surface as an unhandled rejection;
    // a caller awaiting `persisted` still sees the failure.
    persisted.catch(() => {})
    return persisted
  }

  const sessions = (leadSessionID: string): string[] => {
    const currentID = children.get(leadSessionID)
    const recorded = history.get(leadSessionID) ?? (currentID ? [currentID] : [])
    return currentID && !recorded.includes(currentID) ? [...recorded, currentID] : [...recorded]
  }

  return { current, record, reset, forget, sessions }
}
