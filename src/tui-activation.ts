import { Effect } from "effect"
import type { PairStatus } from "./rpc.ts"
import { toHostModel, type HostModel } from "./pair.ts"

export interface ActivationLocation {
  readonly directory: string
}

export type ActivationRoute =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | { readonly type: "plugin"; readonly id?: string; readonly name?: string }

export interface ActivationContext {
  readonly location: ActivationLocation | undefined
  readonly client: {
    readonly session: {
      create(input: { agent: string; model: HostModel; location: ActivationLocation }): Promise<{ readonly id: string }>
      switchAgent(input: { sessionID: string; agent: string }): Promise<void>
      switchModel(input: { sessionID: string; model: HostModel }): Promise<void>
    }
  }
  readonly data: {
    readonly session: {
      sync(sessionID: string): Promise<void>
    }
    readonly location: {
      default(): ActivationLocation
    }
  }
  readonly ui: {
    readonly router: {
      current(): ActivationRoute
      navigate(destination: { readonly type: "session"; readonly sessionID: string }): void
    }
  }
}

const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

export const activateLead = (
  context: ActivationContext,
  status: PairStatus,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const pair = status.pair
    if (!pair) return yield* Effect.fail(new Error("fusion: cannot activate without a saved pair"))
    const model = toHostModel(pair.lead)
    const route = context.ui.router.current()
    if (route.type === "session") {
      const sessionID = route.sessionID
      yield* fromPromise(() => context.client.session.switchAgent({ sessionID, agent: status.leadAgent }))
      yield* fromPromise(() => context.client.session.switchModel({ sessionID, model }))
      yield* fromPromise(() => context.data.session.sync(sessionID))
    } else if (route.type === "home") {
      const location = context.location ?? context.data.location.default()
      const created = yield* fromPromise(() =>
        context.client.session.create({ agent: status.leadAgent, model, location }),
      )
      yield* fromPromise(() => context.data.session.sync(created.id))
      context.ui.router.navigate({ type: "session", sessionID: created.id })
    }
  })
