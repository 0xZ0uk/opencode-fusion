/**
 * Sidekick session registry.
 *
 * Owns the persistent lead→current-sidekick mapping. That map doubles as an LRU:
 * insertion order is recency, and persistence prunes the oldest end to a cap.
 *
 * Storage comes in as a seam — `ctx.storage` in production, an in-memory fake
 * in tests. The persisted shape is normalized and seeded on load; the
 * normalizer stays private here.
 *
 * Mutations change memory synchronously and return the promise of their
 * persistence write, so a caller that needs the write to land before moving on
 * can await it. Writes are serialized: each one snapshots the map when its
 * turn comes, so rapid mutations cannot finish out of order or land stale
 * snapshots last.
 *
 * Type-only imports on purpose: no runtime dependency on `@opencode/*`.
 */
import { Context, Effect, Semaphore } from "effect"
import { facadeScheduler, promiseStorage, type FusionStorageService } from "./host.ts"

/** Lead session -> current sidekick session. Insertion order is recency. */
const CHILDREN_KEY = "sidekick-sessions"
/** Cap on remembered lead→sidekick pairs; the map doubles as an LRU. */
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
   * Set the lead's current sidekick session (LRU touch: delete + re-insert) and
   * persist. The map changes synchronously; the returned promise settles once
   * the write lands.
   */
  record(leadSessionID: string, sidekickSessionID: string): Promise<void>
  /**
   * Drop the lead's current child mapping. A no-op writes nothing. Resolves once
   * the change is persisted.
   */
  reset(leadSessionID: string): Promise<void>
  /**
   * Remove a session id everywhere it appears — as a lead key and as a child
   * value. Resolves to whether anything changed; a no-op writes nothing.
   */
  forget(sessionID: string): Promise<boolean>
}

export interface RegistryService {
  current(leadSessionID: string): string | undefined
  record(leadSessionID: string, sidekickSessionID: string): Effect.Effect<void, unknown>
  reset(leadSessionID: string): Effect.Effect<void, unknown>
  forget(sessionID: string): Effect.Effect<boolean, unknown>
}

export class Registry extends Context.Service<Registry, RegistryService>()("opencode-fusion/Registry") {}

type UnknownRecord = Record<string, unknown>

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined

function normalizeChildren(value: unknown): Record<string, string> {
  const record = asRecord(value) ?? {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) if (typeof entry === "string") out[key] = entry
  return out
}

export const makeRegistry = Effect.fn("makeRegistry")(function* (storage: FusionStorageService) {
  const children = new Map<string, string>(Object.entries(normalizeChildren(yield* storage.get(CHILDREN_KEY))))

  // Writes are serialized on this chain. A write snapshots the map when its
  // turn comes, so a mutation queued behind an in-flight write cannot be
  // overwritten by it, and the last write to land always carries the newest
  // state.
  const writes = yield* Semaphore.make(1)

  /**
   * Prune the map to the cap from the oldest end — synchronously, so readers
   * see the cap immediately — then queue the write.
   */
  const persist = (): Effect.Effect<void, unknown> => {
    while (children.size > CHILDREN_CAP) {
      const oldest = children.keys().next().value
      if (oldest === undefined) break
      children.delete(oldest)
    }
    return writes.withPermits(1)(
      // A failed write must not poison the chain; the caller awaiting it still
      // sees the rejection.
      Effect.suspend(() => storage.set(CHILDREN_KEY, Object.fromEntries(children))),
    )
  }

  const current = (leadSessionID: string): string | undefined => children.get(leadSessionID)

  const record = (leadSessionID: string, sidekickSessionID: string): Effect.Effect<void, unknown> =>
    Effect.suspend(() => {
      children.delete(leadSessionID)
      children.set(leadSessionID, sidekickSessionID)
      return persist()
    })

  const reset = (leadSessionID: string): Effect.Effect<void, unknown> =>
    Effect.suspend(() => {
      if (!children.delete(leadSessionID)) return Effect.void
      return persist()
    })

  const forget = (sessionID: string): Effect.Effect<boolean, unknown> =>
    Effect.suspend(() => {
      let removed = children.delete(sessionID)
      for (const [leadID, sidekickID] of [...children]) {
        if (sidekickID === sessionID) {
          children.delete(leadID)
          removed = true
        }
      }
      if (!removed) return Effect.succeed(false)
      return Effect.as(persist(), true)
    })

  return { current, record, reset, forget }
})

export async function createRegistry(storage: SidekickStorage): Promise<SidekickRegistry> {
  const service = await Effect.runPromise(makeRegistry(promiseStorage(storage)), { scheduler: facadeScheduler })
  return {
    current: (leadSessionID) => service.current(leadSessionID),
    record: (leadSessionID, sidekickSessionID) =>
      Effect.runPromise(service.record(leadSessionID, sidekickSessionID), { scheduler: facadeScheduler }),
    reset: (leadSessionID) => Effect.runPromise(service.reset(leadSessionID), { scheduler: facadeScheduler }),
    forget: (sessionID) => {
      const persisted = Effect.runPromise(service.forget(sessionID), { scheduler: facadeScheduler })
      // Never let an ignored `forget` promise surface as an unhandled rejection;
      // a caller awaiting `persisted` still sees the failure.
      persisted.catch(() => {})
      return persisted
    },
  }
}
