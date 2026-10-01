import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect, Fiber } from "effect"
import { makePairState } from "../src/pair-state.ts"
import type { FusionStorageService } from "../src/host.ts"
import type { FusionPair } from "../src/pair.ts"

const PAIR_INPUT = {
  lead: { providerID: "leadco", modelID: "big", variant: "high" },
  sidekick: { providerID: "cheap", modelID: "small" },
}

const storage = (initial: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(initial))
  const svc: FusionStorageService = {
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
  }
  return { svc, store }
}

const build = (options: {
  storage: FusionStorageService
  reload?: Effect.Effect<void, unknown>
  changed?: (pair: FusionPair) => Effect.Effect<void, unknown>
}) => {
  const emitted: FusionPair[] = []
  let reloads = 0
  const make = makePairState({
    storage: options.storage,
    leadAgent: "lead-x",
    sidekickAgent: "sk-x",
    reload: options.reload ?? Effect.sync(() => (reloads += 1)),
    changed:
      options.changed ??
      ((pair) =>
        Effect.sync(() => {
          emitted.push(pair)
        })),
  })
  return { make, emitted, reloads: () => reloads }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("makePairState", () => {
  it("loads the stored pair with the configured agent ids overriding stored ones", async () => {
    const { svc } = storage({ pair: { ...PAIR_INPUT, leadAgent: "stored", sidekickAgent: "stored" } })
    const { make } = build({ storage: svc })
    const state = await Effect.runPromise(make)

    assert.equal(state.current()?.leadAgent, "lead-x")
    assert.equal(state.current()?.sidekickAgent, "sk-x")
    const status = state.status()
    assert.equal(status.configured, true)
    assert.equal(status.pair?.sidekick.modelID, "small")
  })

  it("is a no-op for invalid input: no write, no reload, no event, existing status", async () => {
    const { svc, store } = storage()
    const { make, emitted, reloads } = build({ storage: svc })
    const state = await Effect.runPromise(make)

    const status = await Effect.runPromise(state.setPair({ junk: true }))
    assert.equal(status.configured, false)
    assert.equal(store.has("pair"), false)
    assert.equal(reloads(), 0)
    assert.equal(emitted.length, 0)
  })

  it("leaves the current pair untouched when the storage write fails", async () => {
    const svc: FusionStorageService = {
      get: () => Effect.succeed({ pair: PAIR_INPUT }.pair),
      set: () => Effect.fail(new Error("disk full")),
    }
    const { make, emitted, reloads } = build({ storage: svc })
    const state = await Effect.runPromise(make)
    const before = state.current()

    await assert.rejects(
      Effect.runPromise(state.setPair({ lead: PAIR_INPUT.lead, sidekick: { providerID: "x", modelID: "y" } })),
      /disk full/,
    )
    assert.equal(state.current(), before)
    assert.equal(reloads(), 0)
    assert.equal(emitted.length, 0)
  })

  it("serializes concurrent saves; each persists then reloads and emits that same pair", async () => {
    const saved: unknown[] = []
    let gate!: () => void
    const firstWrite = new Promise<void>((resolve) => (gate = resolve))
    const svc: FusionStorageService = {
      get: () => Effect.succeed(undefined),
      set: (key, value) =>
        Effect.promise(async () => {
          saved.push(value)
          if (saved.length === 1) await firstWrite
        }),
    }
    const order: string[] = []
    const { make } = build({
      storage: svc,
      reload: Effect.sync(() => order.push("reload")),
      changed: (pair) => Effect.sync(() => order.push(`emit:${pair.sidekick.modelID}`)),
    })
    const state = await Effect.runPromise(make)

    const one = Effect.runPromise(state.setPair({ lead: PAIR_INPUT.lead, sidekick: { providerID: "p", modelID: "s1" } }))
    const two = Effect.runPromise(state.setPair({ lead: PAIR_INPUT.lead, sidekick: { providerID: "p", modelID: "s2" } }))
    await settle()
    gate()

    const [s1, s2] = await Promise.all([one, two])
    assert.deepEqual(order, ["reload", "emit:s1", "reload", "emit:s2"])
    assert.equal(s1.pair?.sidekick.modelID, "s1")
    assert.equal(s2.pair?.sidekick.modelID, "s2")
    assert.equal(state.current()?.sidekick.modelID, "s2")
  })

  it("does not deadlock when a queued save is interrupted", async () => {
    let gate!: () => void
    const firstWrite = new Promise<void>((resolve) => (gate = resolve))
    let writes = 0
    const svc: FusionStorageService = {
      get: () => Effect.succeed(undefined),
      set: (key, value) =>
        Effect.promise(async () => {
          writes += 1
          if (writes === 1) await firstWrite
        }),
    }
    const { make } = build({ storage: svc })
    const state = await Effect.runPromise(make)

    const holder = Effect.runPromise(state.setPair({ lead: PAIR_INPUT.lead, sidekick: { providerID: "p", modelID: "s1" } }))
    const interrupted = Effect.runFork(state.setPair({ lead: PAIR_INPUT.lead, sidekick: { providerID: "p", modelID: "s2" } }))
    const third = Effect.runPromise(state.setPair({ lead: PAIR_INPUT.lead, sidekick: { providerID: "p", modelID: "s3" } }))
    await settle()
    assert.equal(writes, 1)

    await Effect.runPromise(Fiber.interrupt(interrupted))
    await settle()
    assert.equal(writes, 1, "third save still waits on the holder")

    gate()
    await holder
    await third
    assert.equal(state.current()?.sidekick.modelID, "s3")
  })

  it("the late current() read reflects a re-pair", async () => {
    const { svc } = storage()
    const { make } = build({ storage: svc })
    const state = await Effect.runPromise(make)
    assert.equal(state.current(), undefined)

    await Effect.runPromise(state.setPair(PAIR_INPUT))
    assert.equal(state.current()?.lead.modelID, "big")
  })

  it("apply reloads and reports applied", async () => {
    const { svc } = storage()
    const { make, reloads } = build({ storage: svc })
    const state = await Effect.runPromise(make)
    assert.deepEqual(await Effect.runPromise(state.apply()), { applied: true })
    assert.equal(reloads(), 1)
  })
})
