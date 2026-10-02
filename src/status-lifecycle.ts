/**
 * The status line's lifecycle.
 *
 * `claimStatus` renders a sentence; this module keeps what that sentence reads
 * true. It owns the memory store the slot renders from and its seed, the host
 * session snapshot behind it, the session events that can change a lead's
 * sidekicks, the pair refresh at startup and on every `pairChanged`, the
 * fallback for an unreachable server plugin, and the monotonic guard that
 * drops a slow read that a newer one overtook.
 *
 * Pair consistency is RPC-event-only, and that is the point of the guard: the
 * server's `pairChanged` event is the only thing that refreshes this state, so
 * a command that saves a pair must not write here — it would race the event
 * that is already on its way.
 *
 * One entry point, `startStatusLifecycle`, and one aggregate disposer: the
 * lifecycle is started by being constructed, so there is no create-then-start
 * window in which a subscription is registered but nothing refreshes. Its
 * subscriptions are taken before the first refresh, so there is no window in
 * which a `pairChanged` is missed either. A read still in flight when the
 * lifecycle is disposed never reaches the store, and a registration that throws
 * releases what was already taken.
 *
 * JSX-free, with type-only `@opencode/*` imports, so tests drive it on plain
 * Node.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { Effect } from "effect"
import { LEAD_AGENT, SIDEKICK_AGENT, type FusionPair } from "./pair.ts"
import type { FusionClient, PairStatus } from "./rpc.ts"
import type { SidekickSession } from "./sidekick-state.ts"
import type { StatusLineState } from "./statusline.ts"
import type { TuiRuntime } from "./tui-runtime.ts"

/** The reactive state the status slot renders: the pair, the lead agent, and the host's revision. */
export type StatusLineStore = StatusLineState & {
  /**
   * Bumped on every session event. `context.data.session.*` is not a reactive
   * read — the TUI context annotates the reads that are, and those are only the
   * `ui.*` ones — so this is what pulls a fresh host snapshot into the render.
   */
  readonly sessionsVersion: number
}

/** Exactly what the status slot needs to render: its state and the host sessions behind it. */
export type StatusClaim = {
  readonly state: StatusLineStore
  /** The host's sessions in the shape the sidekick-state derivation reads. */
  readonly sessions: () => readonly SidekickSession[]
}

/** A started lifecycle: the claim input for `claimStatus`, plus one disposer for everything it owns. */
export type StatusLifecycle = {
  readonly claim: StatusClaim
  dispose(): void
}

/**
 * Session events that can change which sidekicks a lead has, or whether one
 * runs. Names verified against the host's event types: session.created
 * (SessionCreated), session.deleted (SessionDeleted), session.metadata.updated
 * (SessionMetadataUpdated), session.status (SessionStatusUpdated) and
 * session.idle (SessionIdle).
 */
const SESSION_EVENTS = [
  "session.created",
  "session.deleted",
  "session.metadata.updated",
  "session.status",
  "session.idle",
  "session.agent.selected",
  "session.model.selected",
] as const

const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

/** The pair as the TUI believes it when the server plugin cannot be reached: nothing is paired yet. */
const unconfigured = (): PairStatus => ({
  configured: false,
  leadAgent: LEAD_AGENT,
  sidekickAgent: SIDEKICK_AGENT,
})

/**
 * Starts the status line's lifecycle: seeds the store, subscribes to the
 * session events, refreshes the pair once, and keeps refreshing it on
 * `pairChanged`.
 */
export function startStatusLifecycle(deps: {
  readonly context: Plugin.Context
  readonly fusion: FusionClient
  readonly runtime: TuiRuntime
}): StatusLifecycle {
  const { context, fusion, runtime } = deps
  const owned: Array<() => void> = []

  const [state, setState] = context.storage.memory("fusion-status", {
    initial: {
      pair: undefined as FusionPair | undefined,
      leadAgent: LEAD_AGENT,
      sessionsVersion: 0,
    },
  })

  /**
   * The host's sessions, in the shape the sidekick-state derivation reads.
   *
   * Run status is merged in here rather than read off the session: the host's
   * `SessionInfo` has no status field, it is a separate synchronous
   * `data.session.status(id)` call. `SidekickSession.status` is required, so
   * dropping this line stops the build instead of silently pinning the status
   * line to "not running".
   */
  const sessions = (): SidekickSession[] =>
    context.data.session.list().map((session) => ({
      id: session.id,
      metadata: session.metadata,
      time: session.time,
      status: context.data.session.status(session.id),
    }))

  const bumpSessions = () =>
    setState((draft) => {
      draft.sessionsVersion += 1
    })

  const loadPair: Effect.Effect<PairStatus> = fromPromise(() => fusion.getPair()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.warn(`[fusion] server plugin unreachable: ${String(error)}`)
        return unconfigured()
      }),
    ),
  )

  const applyStatus = (status: PairStatus) =>
    setState((draft) => {
      draft.pair = status.pair
      draft.leadAgent = status.leadAgent
    })

  /**
   * Monotonic revision, invalidated on disposal: a read that a newer one
   * overtook — or that lands after the lifecycle is gone — is dropped rather
   * than applied, so a slow `getPair` cannot resurrect a stale pair and a
   * pending one cannot write to the store after `dispose`. The revision is the
   * guard; `disposed` keeps a late event from even starting a read.
   */
  let revision = 0
  let disposed = false
  const refresh = () => {
    if (disposed) return
    const mine = ++revision
    void runtime
      .runPromise(
        Effect.flatMap(loadPair, (status) =>
          Effect.sync(() => {
            if (!disposed && mine === revision) applyStatus(status)
          }),
        ),
      )
      .catch(() => {})
  }

  /**
   * Everything the lifecycle owns, released in reverse order. `splice` empties
   * the list first, so the aggregate disposer is idempotent even if one of the
   * disposers throws.
   */
  const release = () => {
    const disposers = owned.splice(0, owned.length)
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
  }

  // Subscribed before the first refresh, so there is no window in which a
  // `pairChanged` can land on a lifecycle that is not yet listening. A throw
  // here is a setup failure: release what was already taken rather than leak
  // subscriptions nothing will ever release.
  try {
    for (const type of SESSION_EVENTS) owned.push(context.data.on(type, bumpSessions))
    owned.push(fusion.events.on("pairChanged", refresh))
  } catch (error) {
    release()
    throw error
  }

  refresh()

  return {
    claim: { state, sessions },
    dispose: () => {
      if (disposed) return
      disposed = true
      revision += 1
      release()
    },
  }
}
