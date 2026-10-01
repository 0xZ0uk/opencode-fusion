import { Clock, Effect } from "effect"
import { sameModel, type FusionPair, type ModelRef } from "./pair.ts"
import type { HostModel } from "./pair.ts"

export interface AgentSyncApi {
  readonly ensureApplied: Effect.Effect<void>
}

export const makeAgentSync = Effect.fn("makeAgentSync")(function* (deps: {
  list: Effect.Effect<readonly { id: string; model?: HostModel }[], unknown>
  reload: Effect.Effect<void, unknown>
  pair: () => FusionPair | undefined
  leadAgent: string
  sidekickAgent: string
  trace: (step: string, detail?: unknown) => void
}) {
  const { list, reload, pair, leadAgent, sidekickAgent, trace } = deps

  /**
   * Plugins load before config agents are registered, so the first replay sees
   * nothing (`editor.get` is undefined). Re-apply once they land — idempotent:
   * reload only while an agent is still missing the model we expect.
   */
  let applying = false
  let attempts = 0
  let lastAttempt = 0
  const check = Effect.gen(function* () {
    const current = pair()
    if (!current) return
    const listed = yield* list
    trace("agents:listed", listed.map((agent) => `${agent.id}=${agent.model?.id ?? "none"}`))
    // Registered but not on the pair's model counts as drift; not registered
    // at all does not, or this would reload forever on a missing agent.
    const stale = (id: string, ref: ModelRef) => {
      const found = listed.find((agent) => agent.id === id)
      return Boolean(found) && !sameModel(ref, found?.model)
    }
    if (stale(leadAgent, current.lead) || stale(sidekickAgent, current.sidekick)) {
      trace("agents:reapply", { attempt: attempts })
      yield* reload
    }
  })

  const ensureApplied: Effect.Effect<void> = Effect.suspend(() => {
    if (applying) return Effect.void
    // Our own reload emits agent.updated, so this must be capped, not reactive-only.
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (attempts >= 5 || now - lastAttempt < 400) return
      attempts += 1
      lastAttempt = now
      applying = true
      yield* check.pipe(
        Effect.catch((error) => Effect.sync(() => trace(`agents:reapply:failed ${String(error)}`))),
        Effect.ensuring(
          Effect.sync(() => {
            applying = false
          }),
        ),
      )
    })
  })

  return { ensureApplied }
})
