import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect, Fiber } from "effect"
import { createRegistry, makeRegistry } from "../src/registry.ts"
import type { FusionStorageService } from "../src/host.ts"

const CHILDREN = "sidekick-sessions"

const memoryStorage = (initial: Record<string, unknown> = {}): FusionStorageService & { store: Map<string, unknown> } => {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    store,
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => store.set(key, value)),
  }
}

const gatedStorage = () => {
  const store = new Map<string, unknown>()
  const pending: Array<{ key: string; value: unknown; release(): void; fail(e: unknown): void }> = []
  const storage: FusionStorageService = {
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) =>
      Effect.callback<void>((resume) => {
        pending.push({
          key,
          value,
          release: () => {
            store.set(key, value)
            resume(Effect.void)
          },
          fail: (error) => resume(Effect.fail(error) as unknown as Effect.Effect<void>),
        })
      }),
  }
  return { storage, store, pending }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("makeRegistry (native)", () => {
  it("is lazy: mutations wait for the effect to run", async () => {
    const fx = memoryStorage()
    const { store } = fx
    const registry = await Effect.runPromise(makeRegistry(fx))

    const write = registry.record("lead", "sk1")
    assert.equal(registry.current("lead"), undefined)
    assert.equal(store.has(CHILDREN), false)

    await Effect.runPromise(write)
    assert.equal(registry.current("lead"), "sk1")
    assert.deepEqual(store.get(CHILDREN), { lead: "sk1" })
  })

  it("serializes writes and snapshots the newest map at each turn", async () => {
    const { storage, store, pending } = gatedStorage()
    const registry = await Effect.runPromise(makeRegistry(storage))

    const first = Effect.runPromise(registry.record("lead", "sk1"))
    const second = Effect.runPromise(registry.record("lead", "sk2"))
    const third = Effect.runPromise(registry.reset("lead"))
    await settle()
    assert.equal(pending.length, 1)

    while (pending.length > 0) {
      pending.shift()!.release()
      await settle()
    }
    await Promise.all([first, second, third])
    assert.deepEqual(store.get(CHILDREN), {})
  })

  it("lets the next write through after a failure and still rejects the caller", async () => {
    const { storage, store, pending } = gatedStorage()
    const registry = await Effect.runPromise(makeRegistry(storage))

    const failed = Effect.runPromise(registry.record("lead", "sk1"))
    const next = Effect.runPromise(registry.record("lead", "sk2"))
    await settle()

    pending.shift()!.fail(new Error("storage down"))
    await assert.rejects(failed, /storage down/)
    await settle()

    while (pending.length > 0) {
      pending.shift()!.release()
      await settle()
    }
    await next
    assert.deepEqual(store.get(CHILDREN), { lead: "sk2" })
  })

  it("does not deadlock the queue when a waiting write is interrupted", async () => {
    const { storage, store, pending } = gatedStorage()
    const registry = await Effect.runPromise(makeRegistry(storage))

    const holder = Effect.runPromise(registry.record("lead", "sk1"))
    const interruptedFiber = Effect.runFork(registry.record("lead", "sk2"))
    const third = Effect.runPromise(registry.record("lead", "sk3"))
    await settle()
    assert.equal(pending.length, 1)

    await Effect.runPromise(Fiber.interrupt(interruptedFiber))
    assert.equal(pending.length, 1, "queued write C still waits behind the holder")
    assert.equal(registry.current("lead"), "sk3")

    while (pending.length > 0) {
      pending.shift()!.release()
      await settle()
    }
    await holder
    await third
    assert.deepEqual(store.get(CHILDREN), { lead: "sk3" })
  })
})

describe("createRegistry facade", () => {
  it("mutates memory synchronously at invocation", async () => {
    const store = new Map<string, unknown>()
    const pending: Array<{ key: string; value: unknown; release(): void; fail(e: unknown): void }> = []
    const registry = await createRegistry({
      get: async (key) => store.get(key),
      set: (key, value) =>
        new Promise<void>((resolve) =>
          pending.push({ key, value, release: () => { store.set(key, value); resolve() }, fail: () => {} }),
        ),
    })

    const write = registry.record("lead", "sk1")
    assert.equal(registry.current("lead"), "sk1")

    while (pending.length > 0) pending.shift()!.release()
    await write
    assert.deepEqual(store.get(CHILDREN), { lead: "sk1" })
  })
})
