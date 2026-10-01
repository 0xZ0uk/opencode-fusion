import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { makeSidekickSessions } from "../src/sidekick-sessions.ts"
import { makeRegistry } from "../src/registry.ts"
import type { FusionHostService, FusionStorageService } from "../src/host.ts"
import type { FusionPair, HostModel } from "../src/pair.ts"

const PAIR: FusionPair = {
  lead: { providerID: "leadco", modelID: "big" },
  sidekick: { providerID: "cheap", modelID: "small" },
  leadAgent: "fusion",
  sidekickAgent: "sidekick",
}

const storage = (): FusionStorageService & { store: Map<string, unknown> } => {
  const store = new Map<string, unknown>()
  return {
    store,
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => store.set(key, value)),
  }
}

const host = (create?: (input: { agent: string; title: string }) => Effect.Effect<{ id: string }, unknown>) => {
  let counter = 0
  const creates: Array<{ agent: string; title: string }> = []
  const svc: FusionHostService = {
    prompt: () => Effect.die(new Error("unused")),
    wait: () => Effect.die(new Error("unused")),
    context: () => Effect.die(new Error("unused")),
    interrupt: () => Effect.die(new Error("unused")),
    synthetic: () => Effect.die(new Error("unused")),
    workingDiff: () => Effect.succeed([]),
    get: (sessionID) => Effect.succeed({ archived: false, model: { id: "small", providerID: "cheap" } as HostModel }),
    create: (input) =>
      create
        ? create(input)
        : Effect.sync(() => {
            counter += 1
            creates.push(input)
            return { id: `sk-${counter}` }
          }),
    switchModel: () => Effect.void,
  }
  return { host: svc, creates }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("ensure serialization", () => {
  it("creates once for concurrent ensures of the same lead", async () => {
    let releaseCreate!: () => void
    const gate = new Promise<void>((resolve) => (releaseCreate = resolve))
    let creates = 0
    const { host: h } = host(() =>
      Effect.promise(async () => {
        creates += 1
        await gate
        return { id: "sk-1" }
      }),
    )
    const sessions = Effect.runSync(
      makeSidekickSessions({
        host: h,
        registry: Effect.runSync(makeRegistry(storage())),
        sidekickAgent: "sidekick",
        currentPair: () => PAIR,
      }),
    )

    const first = Effect.runPromise(sessions.ensure("lead-1"))
    const second = Effect.runPromise(sessions.ensure("lead-1"))
    await settle()
    releaseCreate()

    assert.equal(await first, "sk-1")
    assert.equal(await second, "sk-1")
    assert.equal(creates, 1)
    assert.equal(sessions.current("lead-1"), "sk-1")
  })

  it("does not block independent leads", async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))
    let calls = 0
    const { host: h } = host((input) =>
      Effect.promise(async () => {
        calls += 1
        if (calls === 1) await gateA
        return { id: `sk-${calls}` }
      }),
    )
    const sessions = Effect.runSync(
      makeSidekickSessions({
        host: h,
        registry: Effect.runSync(makeRegistry(storage())),
        sidekickAgent: "sidekick",
        currentPair: () => PAIR,
      }),
    )

    const a = Effect.runPromise(sessions.ensure("lead-a"))
    await settle()
    const b = await Effect.runPromise(sessions.ensure("lead-b"))
    releaseA()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const idA = await a
    assert.equal(sessions.current("lead-a"), idA)
    assert.equal(sessions.current("lead-b"), b)
    assert.ok(idA !== undefined && b !== undefined)
  })

  it("releases the lock after a failed ensure so a retry can create", async () => {
    let calls = 0
    const { host: h, creates } = host(() =>
      Effect.suspend(() => {
        calls += 1
        return calls === 1 ? Effect.fail(new Error("create failed")) : Effect.succeed({ id: "sk-1" })
      }),
    )
    const sessions = Effect.runSync(
      makeSidekickSessions({
        host: h,
        registry: Effect.runSync(makeRegistry(storage())),
        sidekickAgent: "sidekick",
        currentPair: () => PAIR,
      }),
    )

    await assert.rejects(Effect.runPromise(sessions.ensure("lead-1")), /create failed/)
    assert.equal(await Effect.runPromise(sessions.ensure("lead-1")), "sk-1")
  })

  it("serializes forget behind an in-flight ensure", async () => {
    let releaseCreate!: () => void
    const gate = new Promise<void>((resolve) => (releaseCreate = resolve))
    const { host: h } = host(() =>
      Effect.promise(async () => {
        await gate
        return { id: "sk-1" }
      }),
    )
    const sessions = Effect.runSync(
      makeSidekickSessions({
        host: h,
        registry: Effect.runSync(makeRegistry(storage())),
        sidekickAgent: "sidekick",
        currentPair: () => PAIR,
      }),
    )

    const ensure = Effect.runPromise(sessions.ensure("lead-1"))
    const forget = Effect.runPromise(sessions.forget("lead-1"))
    await settle()
    releaseCreate()

    await Promise.all([ensure, forget])
    assert.equal(sessions.current("lead-1"), undefined)
  })
})
