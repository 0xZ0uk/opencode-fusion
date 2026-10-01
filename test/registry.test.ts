import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRegistry, type SidekickStorage } from "../src/registry.ts"

// The registry owns this key; the tests only need it to seed the fake.
const CHILDREN = "sidekick-sessions"
/** An install from an older version may still carry this key; it is now orphaned. */
const LEGACY_HISTORY = "sidekick-history"

/** Storage seam fake: values are applied synchronously, reads are async. */
function memoryStorage(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const storage: SidekickStorage = {
    async get(key) {
      return store.get(key)
    },
    async set(key, value) {
      store.set(key, value)
    },
  }
  return { storage, store }
}

type GatedWrite = { key: string; value: unknown; release(): void; fail(error: unknown): void }

/**
 * Storage whose writes stay pending until the test releases them, so a test can
 * keep one write in flight while newer mutations queue up behind it.
 */
function gatedStorage() {
  const store = new Map<string, unknown>()
  const pending: GatedWrite[] = []
  const storage: SidekickStorage = {
    async get(key) {
      return store.get(key)
    },
    set(key, value) {
      return new Promise<void>((resolve, reject) => {
        pending.push({
          key,
          value,
          release: () => {
            store.set(key, value)
            resolve()
          },
          fail: (error) => reject(error),
        })
      })
    },
  }
  return { storage, store, pending }
}

/** Let queued promise work run before the next assertion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Release pending writes one at a time until the queue drains. */
async function releaseAll(pending: GatedWrite[]): Promise<void> {
  while (pending.length > 0) {
    const write = pending.shift()
    if (!write) break
    write.release()
    await settle()
  }
}

describe("load", () => {
  it("normalizes a junk persisted blob through the interface", async () => {
    const { storage } = memoryStorage({ [CHILDREN]: { a: "s1", b: 7, c: null } })
    const registry = await createRegistry(storage)

    assert.equal(registry.current("a"), "s1")
    // Non-string child entries drop.
    assert.equal(registry.current("b"), undefined)
    assert.equal(registry.current("c"), undefined)
  })

  it("treats non-object or missing blobs as empty", async () => {
    for (const junk of [undefined, "junk", null, 42]) {
      const { storage } = memoryStorage({ [CHILDREN]: junk })
      const registry = await createRegistry(storage)
      assert.equal(registry.current("x"), undefined)
    }
  })

  it("never reads the orphaned history key an older install may still carry", async () => {
    const { storage, store } = memoryStorage({
      [CHILDREN]: { lead: "sk-live" },
      [LEGACY_HISTORY]: { lead: ["sk-old"], other: ["sk-1", "sk-2"] },
    })
    const registry = await createRegistry(storage)

    assert.equal(registry.current("lead"), "sk-live")
    // The old session ids are not reachable through the registry any more.
    assert.equal(registry.current("other"), undefined)

    await registry.record("lead", "sk-new")
    assert.deepEqual(store.get(CHILDREN), { lead: "sk-new" })
    // Untouched, and never written back.
    assert.deepEqual(store.get(LEGACY_HISTORY), { lead: ["sk-old"], other: ["sk-1", "sk-2"] })
  })
})

describe("record", () => {
  it("sets the current child, last write wins", async () => {
    const { storage } = memoryStorage()
    const registry = await createRegistry(storage)

    await registry.record("lead", "sk1")
    assert.equal(registry.current("lead"), "sk1")

    await registry.record("lead", "sk2")
    assert.equal(registry.current("lead"), "sk2")

    // Re-recording an older id makes it current again.
    await registry.record("lead", "sk1")
    assert.equal(registry.current("lead"), "sk1")
  })

  it("mutates in memory synchronously and resolves only once the write lands", async () => {
    const { storage, store, pending } = gatedStorage()
    const registry = await createRegistry(storage)

    let settled = false
    const write = registry.record("lead", "sk1").then(() => {
      settled = true
    })

    // The mapping is visible before the write settles.
    assert.equal(registry.current("lead"), "sk1")
    await settle()
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.key, CHILDREN)
    assert.deepEqual(pending[0]?.value, { lead: "sk1" })
    assert.equal(settled, false)

    await releaseAll(pending)
    await write
    assert.equal(settled, true)
    assert.deepEqual(store.get(CHILDREN), { lead: "sk1" })
  })

  it("touches recency so a re-recorded lead survives the cap", async () => {
    const { storage } = memoryStorage()
    const registry = await createRegistry(storage)

    const writes: Promise<void>[] = []
    for (let i = 0; i < 200; i += 1) writes.push(registry.record(`lead-${i}`, `sk-${i}`))
    // Touch lead-0: it moves to the newest end of the LRU.
    writes.push(registry.record("lead-0", "sk-0b"))
    // Overflow by one; the map prunes synchronously, so the oldest is now lead-1.
    writes.push(registry.record("lead-200", "sk-200"))

    assert.equal(registry.current("lead-0"), "sk-0b")
    assert.equal(registry.current("lead-1"), undefined)
    await Promise.all(writes)
  })

  it("prunes the map to the cap from the oldest end on persist", async () => {
    const { storage, store } = memoryStorage()
    const registry = await createRegistry(storage)

    const writes: Promise<void>[] = []
    for (let i = 0; i <= 200; i += 1) writes.push(registry.record(`lead-${i}`, `sk-${i}`))

    // Pruning happens in memory even though the writes are queued.
    assert.equal(registry.current("lead-0"), undefined)
    assert.equal(registry.current("lead-1"), "sk-1")

    await Promise.all(writes)
    const children = store.get(CHILDREN) as Record<string, string>
    assert.equal(Object.keys(children).length, 200)
    assert.equal(children["lead-0"], undefined)
    assert.equal(children["lead-200"], "sk-200")
  })
})

describe("reset", () => {
  it("drops the current child", async () => {
    const { storage } = memoryStorage()
    const registry = await createRegistry(storage)

    await registry.record("lead", "sk1")
    await registry.reset("lead")

    assert.equal(registry.current("lead"), undefined)
  })
})

describe("forget", () => {
  it("removes the session id as a child value and as a lead key", async () => {
    const { storage } = memoryStorage({
      [CHILDREN]: { lead1: "sk1", sk1: "childX", lead2: "sk2" },
    })
    const registry = await createRegistry(storage)

    assert.equal(await registry.forget("sk1"), true)
    // As a child value and as a lead key.
    assert.equal(registry.current("lead1"), undefined)
    assert.equal(registry.current("sk1"), undefined)
    // Untouched leads keep their mapping.
    assert.equal(registry.current("lead2"), "sk2")

    assert.equal(await registry.forget("sk1"), false)
    assert.equal(await registry.forget("missing"), false)
  })

  it("persists the pruned map", async () => {
    const { storage, store } = memoryStorage({ [CHILDREN]: { lead1: "sk1" } })
    const registry = await createRegistry(storage)

    assert.equal(await registry.forget("sk1"), true)

    assert.deepEqual(store.get(CHILDREN), {})
  })
})

describe("persistence", () => {
  it("round-trips recorded mappings through a fresh registry", async () => {
    const { storage } = memoryStorage()
    const first = await createRegistry(storage)
    await first.record("lead", "sk1")
    await first.record("lead", "sk2")
    await first.record("lone", "sk3")

    const reloaded = await createRegistry(storage)
    assert.equal(reloaded.current("lead"), "sk2")
    assert.equal(reloaded.current("lone"), "sk3")
  })

  it("persists a reset: the child drops", async () => {
    const { storage, store } = memoryStorage()
    const registry = await createRegistry(storage)
    await registry.record("lead", "sk1")
    await registry.reset("lead")

    assert.deepEqual(store.get(CHILDREN), {})

    const reloaded = await createRegistry(storage)
    assert.equal(reloaded.current("lead"), undefined)
  })

  it("skips the write when there is nothing to change", async () => {
    const { storage, store } = memoryStorage()
    const registry = await createRegistry(storage)
    await registry.reset("unknown")
    assert.equal(await registry.forget("unknown"), false)
    await settle()

    assert.equal(store.get(CHILDREN), undefined)
  })
})

describe("write ordering", () => {
  it("holds the next write until the in-flight one settles", async () => {
    const { storage, store, pending } = gatedStorage()
    const registry = await createRegistry(storage)

    const first = registry.record("lead", "sk1")
    // A newer, contradictory mutation arrives while the first write is in flight.
    const second = registry.record("lead", "sk2")
    await settle()

    assert.equal(pending.length, 1, "the second write must wait for the first")

    await releaseAll(pending)
    await Promise.all([first, second])

    assert.deepEqual(store.get(CHILDREN), { lead: "sk2" })
  })

  it("keeps the queue moving after a failed write", async () => {
    const { storage, store, pending } = gatedStorage()
    const registry = await createRegistry(storage)

    const failed = registry.record("lead", "sk1")
    const next = registry.record("lead", "sk2")
    await settle()

    const write = pending.shift()
    assert.ok(write, "the first write is in flight")
    write.fail(new Error("storage down"))
    await assert.rejects(failed, /storage down/)

    await settle()
    await releaseAll(pending)
    await next

    // The failure left no snapshot behind; the queued write lands the newest state.
    assert.deepEqual(store.get(CHILDREN), { lead: "sk2" })
  })
})
