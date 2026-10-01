import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { createTuiRuntime, withTuiRuntime, type TuiRuntime } from "../src/tui-runtime.ts"

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("tui runtime bridge", () => {
  it("releases registered disposers in reverse order on dispose", async () => {
    const runtime = createTuiRuntime()
    const released: string[] = []
    runtime.register("first", (r) => released.push(r))
    runtime.register("second", (r) => released.push(r))
    await runtime.dispose()
    assert.deepEqual(released, ["second", "first"])
  })

  it("interrupts jobs on dispose so no late work lands", async () => {
    const runtime = createTuiRuntime()
    const seen: string[] = []
    let releaseJob!: () => void
    const gate = new Promise<void>((resolve) => (releaseJob = resolve))
    const job = Effect.gen(function* () {
      yield* Effect.promise(() => gate)
      seen.push("late")
    })
    const pending = runtime.runPromise(job).catch(() => "interrupted")
    await settle()
    await runtime.dispose()
    releaseJob()
    await settle()
    assert.equal(await pending, "interrupted")
    assert.deepEqual(seen, [])
  })

  it("dispose is idempotent and safe to run twice, concurrently", async () => {
    const runtime = createTuiRuntime()
    const released: string[] = []
    runtime.register("x", (r) => released.push(r))
    const first = runtime.dispose()
    const second = runtime.dispose()
    await first
    await second
    await runtime.dispose()
    assert.deepEqual(released, ["x"])
    assert.equal(runtime.isDisposed(), true)
  })

  it("still runs the runtime disposal when a release defects", async () => {
    const runtime = createTuiRuntime()
    const released: string[] = []
    runtime.register("bad", () => {
      throw new Error("release exploded")
    })
    runtime.register("good", (r) => released.push(r))
    await runtime.dispose()
    assert.deepEqual(released, ["good"])
    assert.equal(runtime.isDisposed(), true)
  })

  it("rejects new work after dispose without running it", async () => {
    const runtime = createTuiRuntime()
    await runtime.dispose()
    let ran = false
    await assert.rejects(runtime.runPromise(Effect.sync(() => (ran = true))), /disposed/)
    assert.equal(ran, false)
    assert.throws(() => runtime.register("x", () => {}), /disposed/)
  })

  it("returns command results through runPromise", async () => {
    const runtime = createTuiRuntime()
    assert.equal(await runtime.runPromise(Effect.succeed(42)), 42)
    await runtime.dispose()
  })
})

describe("withTuiRuntime", () => {
  it("releases acquired disposers and pending jobs when setup fails", async () => {
    const released: string[] = []
    const seen: string[] = []
    let releaseJob!: () => void
    const gate = new Promise<void>((resolve) => (releaseJob = resolve))
    let captured!: TuiRuntime
    await assert.rejects(
      withTuiRuntime((runtime) => {
        captured = runtime
        runtime.register("offSessions", (r) => released.push(r))
        runtime.register("offPair", (r) => released.push(r))
        void runtime.runPromise(
          Effect.gen(function* () {
            yield* Effect.promise(() => gate)
            seen.push("late")
          }),
        ).catch(() => {})
        throw new Error("claimStatus failed")
      }),
      /claimStatus failed/,
    )
    assert.deepEqual(released.sort(), ["offPair", "offSessions"])
    assert.equal(captured.isDisposed(), true)
    releaseJob()
    await settle()
    assert.deepEqual(seen, [])
  })

  it("returns a cleanup that disposes the runtime on success", async () => {
    let captured!: TuiRuntime
    const cleanup = await withTuiRuntime((runtime) => {
      captured = runtime
    })
    assert.equal(captured.isDisposed(), false)
    await cleanup()
    assert.equal(captured.isDisposed(), true)
  })
})

describe("wizard adapters", () => {
  it("a select pending at unload resolves; the next adapter call never reaches the host", async () => {
    const hostCalls: string[] = []
    const toasts: string[] = []
    let resolveFirst!: () => void
    let selectCalls = 0

    const runtime = createTuiRuntime()
    const select = () =>
      runtime.runPromise(
        Effect.tryPromise({
          try: () => {
            selectCalls += 1
            return new Promise<void>((resolve) => (resolveFirst = resolve))
          },
          catch: (e) => e,
        }),
      )
    const toast = (message: string) => {
      if (!runtime.isDisposed()) {
        hostCalls.push("toast")
        toasts.push(message)
      }
    }

    const first = select().catch(() => "dropped")
    await settle()
    await runtime.dispose()
    resolveFirst()
    await settle()
    assert.equal(await first, "dropped")

    await assert.rejects(select(), /disposed/)
    assert.equal(selectCalls, 1)
    toast("late")
    assert.deepEqual(toasts, [])
  })
})
