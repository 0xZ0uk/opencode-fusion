/**
 * Sidekick session reuse.
 *
 * Owns the policy behind `SidekickSessions.ensure`: a lead reuses the sidekick
 * session the registry remembers for it, re-syncing that session's model when the
 * pair has moved on, and creating a fresh one when the remembered session is
 * archived or gone.
 *
 * The host calls come in as a `SessionHost` seam, the remembered mapping as the
 * registry, and the pair as a getter — `setPair` replaces the pair after this is
 * built, so the reuse policy has to read it late.
 *
 * Type-only imports on purpose: no runtime dependency on `@opencode/*`.
 */
import { Context, Effect, Semaphore } from "effect"
import type { SidekickRegistry } from "./registry.ts"
import type { RegistryService } from "./registry.ts"
import { sameModel, toHostModel, type FusionPair, type HostModel } from "./pair.ts"
import { facadeScheduler, promiseSessionHost, type EffectSessionHost } from "./host.ts"

/** The slice of the host's session API the reuse policy needs; the adapter owns the casts. */
export type SessionHost = {
  /** `ctx.session.get` mapped to the two fields the policy reads. */
  get(sessionID: string): Promise<{ archived: boolean; model?: HostModel } | undefined>
  create(input: {
    agent: string
    model?: HostModel
    title: string
    metadata: Record<string, string>
  }): Promise<{ id: string }>
  switchModel(input: { sessionID: string; model: HostModel }): Promise<void>
}

/**
 * Metadata every sidekick session carries, naming the lead it belongs to. This
 * module is the writer — it stamps the key at create time — so the reader in
 * sidekick-state.ts imports it from here rather than repeating the string.
 */
export const LEAD_SESSION_KEY = "fusionLeadSession"

export interface SidekickSessions {
  ensure(leadSessionID: string): Promise<string>
  current(leadSessionID: string): string | undefined
  forget(leadSessionID: string): Promise<void>
}

export interface SidekickSessionsApi {
  ensure(leadSessionID: string): Effect.Effect<string, unknown>
  current(leadSessionID: string): string | undefined
  forget(leadSessionID: string): Effect.Effect<void, unknown>
}

export class SidekickSessionsService extends Context.Service<SidekickSessionsService, SidekickSessionsApi>()(
  "opencode-fusion/SidekickSessions",
) {}

export interface SessionsDeps {
  host: EffectSessionHost
  registry: Pick<RegistryService, "current" | "record" | "reset">
  sidekickAgent: string
  currentPair: () => FusionPair | undefined
}

type LeadLock = { readonly semaphore: Semaphore.Semaphore; users: number }

export const makeSidekickSessions = Effect.fn("makeSidekickSessions")(function* (deps: SessionsDeps) {
  const { host, registry, sidekickAgent, currentPair } = deps
  const locks = new Map<string, LeadLock>()

  const withLeadLock = <A>(leadSessionID: string, effect: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> =>
    Effect.suspend(() => {
      let entry = locks.get(leadSessionID)
      if (!entry) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        locks.set(leadSessionID, entry)
      }
      entry.users += 1
      const lock = entry
      return lock.semaphore.withPermits(1)(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lock.users -= 1
            if (lock.users === 0) locks.delete(leadSessionID)
          }),
        ),
      )
    })

  const ensure: (leadSessionID: string) => Effect.Effect<string, unknown> = Effect.fn("ensure")(function* (
    leadSessionID: string,
  ) {
    return yield* withLeadLock(
      leadSessionID,
      Effect.gen(function* () {
        const pair = currentPair()
        const existing = registry.current(leadSessionID)
        if (existing) {
          // LRU touch: recording an existing child moves it to the newest end.
          // Await the write so the touch is durable before the session is reused.
          yield* registry.record(leadSessionID, existing)
          const session = yield* host.get(existing).pipe(
            /* the stored session is gone */
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (session && !session.archived) {
            // A re-pair leaves the stored session on the old model; re-sync it.
            if (pair && !sameModel(pair.sidekick, session.model)) {
              yield* host.switchModel({ sessionID: existing, model: toHostModel(pair.sidekick) })
            }
            return existing
          }
          yield* registry.reset(leadSessionID)
        }
        const created = yield* host.create({
          agent: sidekickAgent,
          ...(pair ? { model: toHostModel(pair.sidekick) } : {}),
          title: pair ? `Sidekick · ${pair.sidekick.modelID}` : "Sidekick",
          metadata: { [LEAD_SESSION_KEY]: leadSessionID },
        })
        // Await the write: the handoff may start as soon as this returns.
        yield* registry.record(leadSessionID, created.id)
        return created.id
      }),
    )
  })

  const forget = (leadSessionID: string): Effect.Effect<void, unknown> =>
    withLeadLock(leadSessionID, registry.reset(leadSessionID))

  return {
    ensure,
    current: (leadSessionID: string) => registry.current(leadSessionID),
    forget,
  }
})

const facadeRegistry = (registry: SidekickRegistry): Pick<RegistryService, "current" | "record" | "reset"> => ({
  current: (leadSessionID) => registry.current(leadSessionID),
  record: (leadSessionID, sidekickSessionID) =>
    Effect.tryPromise({ try: () => registry.record(leadSessionID, sidekickSessionID), catch: (e) => e }),
  reset: (leadSessionID) => Effect.tryPromise({ try: () => registry.reset(leadSessionID), catch: (e) => e }),
})

export function createSidekickSessions(deps: {
  host: SessionHost
  registry: SidekickRegistry
  sidekickAgent: string
  /** Read late: `setPair` replaces the pair after this module is built. */
  currentPair: () => FusionPair | undefined
}): SidekickSessions {
  const service = Effect.runSync(
    makeSidekickSessions({
      host: promiseSessionHost(deps.host),
      registry: facadeRegistry(deps.registry),
      sidekickAgent: deps.sidekickAgent,
      currentPair: deps.currentPair,
    }),
  )
  return {
    ensure: (leadSessionID) => Effect.runPromise(service.ensure(leadSessionID), { scheduler: facadeScheduler }),
    current: (leadSessionID) => service.current(leadSessionID),
    forget: (leadSessionID) => Effect.runPromise(service.forget(leadSessionID), { scheduler: facadeScheduler }),
  }
}
