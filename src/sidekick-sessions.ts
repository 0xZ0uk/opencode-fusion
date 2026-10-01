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
import type { SidekickSessions } from "./handoffs.ts"
import type { SidekickRegistry } from "./registry.ts"
import { sameModel, toHostModel, type FusionPair, type HostModel } from "./pair.ts"

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

export function createSidekickSessions(deps: {
  host: SessionHost
  registry: SidekickRegistry
  sidekickAgent: string
  /** Read late: `setPair` replaces the pair after this module is built. */
  currentPair: () => FusionPair | undefined
}): SidekickSessions {
  const { host, registry, sidekickAgent, currentPair } = deps

  const ensure = async (leadSessionID: string): Promise<string> => {
    const pair = currentPair()
    const existing = registry.current(leadSessionID)
    if (existing) {
      // LRU touch: recording an existing child moves it to the newest end.
      // Await the write so the touch is durable before the session is reused.
      await registry.record(leadSessionID, existing)
      let session: Awaited<ReturnType<SessionHost["get"]>>
      try {
        session = await host.get(existing)
      } catch {
        /* the stored session is gone */
        session = undefined
      }
      if (session && !session.archived) {
        // A re-pair leaves the stored session on the old model; re-sync it.
        if (pair && !sameModel(pair.sidekick, session.model)) {
          await host.switchModel({ sessionID: existing, model: toHostModel(pair.sidekick) })
        }
        return existing
      }
      await registry.reset(leadSessionID)
    }
    const created = await host.create({
      agent: sidekickAgent,
      ...(pair ? { model: toHostModel(pair.sidekick) } : {}),
      title: pair ? `Sidekick · ${pair.sidekick.modelID}` : "Sidekick",
      metadata: { [LEAD_SESSION_KEY]: leadSessionID },
    })
    // Await the write: the handoff may start as soon as this returns.
    await registry.record(leadSessionID, created.id)
    return created.id
  }

  return {
    ensure,
    current: (leadSessionID) => registry.current(leadSessionID),
    forget: (leadSessionID) => registry.reset(leadSessionID),
  }
}
