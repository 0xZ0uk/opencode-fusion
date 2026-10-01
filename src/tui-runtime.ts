import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from "effect"

export interface TuiRuntime {
  runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A>
  runScoped<A, E>(effect: Effect.Effect<A, E>): Promise<A>
  register<A>(resource: A, release: (resource: A) => void): A
  isDisposed(): boolean
  dispose(): Promise<void>
}

export const createTuiRuntime = (): TuiRuntime => {
  const scope = Effect.runSync(Scope.make())
  const runtime = ManagedRuntime.make(Layer.empty)
  let closed = false
  let disposePromise: Promise<void> | undefined

  const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    closed
      ? Promise.reject(new Error("fusion: tui runtime disposed"))
      : runtime.runPromise(Effect.flatMap(Effect.forkIn(effect, scope, { startImmediately: true }), Fiber.join))

  const register = <A>(resource: A, release: (resource: A) => void): A => {
    if (closed) throw new Error("fusion: tui runtime disposed")
    Effect.runSync(
      Effect.acquireRelease(
        Effect.succeed(resource),
        (value) => Effect.sync(() => release(value)),
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    return resource
  }

  return {
    runPromise,
    runScoped: runPromise,
    register,
    isDisposed: () => closed,
    dispose: () => {
      if (!disposePromise) {
        closed = true
        disposePromise = (async () => {
          try {
            await runtime.runPromise(Scope.close(scope, Exit.void))
          } catch (error) {
            console.warn(`[fusion] tui scope close failed: ${String(error)}`)
          } finally {
            await runtime.dispose()
          }
        })()
      }
      return disposePromise
    },
  }
}

export const withTuiRuntime = async (
  setup: (runtime: TuiRuntime) => void | Promise<void>,
): Promise<() => Promise<void>> => {
  const runtime = createTuiRuntime()
  try {
    await setup(runtime)
    return () => runtime.dispose()
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
