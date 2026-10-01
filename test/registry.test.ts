import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRegistry, type SidekickStorage } from "../src/registry.ts"

// The registry owns these keys; the tests only need them to seed the fake.
const CHILDREN = "sidekick-sessions"
const HISTORY = "sidekick-history"

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
    const { storage } = memoryStorage({
      [CHILDREN]: { a: "s1", b: 7, c: null },
      [HISTORY]: {
        a: ["s1", "s2"],
        b: "not-an-array",
        c: [1, "s3", null],
        d: [],
        e: 42,
      },
    })
    const registry = await createRegistry(storage)

    assert.equal(registry.current("a"), "s1")
    assert.deepEqual(registry.sessions("a"), ["s1", "s2"])
    // Non-string child entries and non-array / empty / non-string lists drop.
    assert.equal(registry.current("b"), undefined)
    assert.deepEqual(registry.sessions("b"), [])
    assert.deepEqual(registry.sessions("c"), ["s3"])
    assert.deepEqual(registry.sessions("d"), [])
    assert.deepEqual(registry.sessions("e"), [])
  })

  it("treats non-object or missing blobs as empty", async () => {
    for (const junk of [undefined, "junk", null, 42]) {
      const { storage } = memoryStorage({ [CHILDREN]: junk, [HISTORY]: junk })
      const registry = await createRegistry(storage)
      assert.equal(registry.current("x"), undefined)
      assert.deepEqual(registry.sessions("x"), [])
    }
  })

  it("seeds each loaded current child into its history", async () => {
    const { storage } = memoryStorage({
      [CHILDREN]: { lead: "sk-live", lone: "sk-only", dup: "sk-old" },
      [HISTORY]: { lead: ["sk-old"], dup: ["sk-old", "sk-new"] },
    })
    const registry = await createRegistry(storage)

    assert.deepEqual(registry.sessions("lead"), ["sk-old", "sk-live"])
    assert.deepEqual(registry.sessions("lone"), ["sk-only"])
    // Already present: the seed does not duplicate it.
    assert.deepEqual(registry.sessions("dup"), ["sk-old", "sk-new"])
  })
})

describe("record", () => {
  it("sets the current child and appends to history only when absent", async () => {
    const { storage } = memoryStorage()
    const registry = await createRegistry(storage)

    await registry.record("lead", "sk1")
    assert.equal(registry.current("lead"), "sk1")
    assert.deepEqual(registry.sessions("lead"), ["sk1"])

    await registry.record("lead", "sk2")
    assert.equal(registry.current("lead"), "sk2")
    assert.deepEqual(registry.sessions("lead"), ["sk1", "sk2"])

    // Re-recording sk1 moves it current but does not append it again.
    await registry.record("lead", "sk1")
    assert.equal(registry.current("lead"), "sk1")
    assert.deepEqual(registry.sessions("lead"), ["sk1", "sk2"])
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
    // Overflow by one; the maps prune synchronously, so the oldest is now lead-1.
    writes.push(registry.record("lead-200", "sk-200"))

    assert.equal(registry.current("lead-0"), "sk-0b")
    assert.equal(registry.current("lead-1"), undefined)
    await Promise.all(writes)
  })

  it("prunes both maps to the cap from the oldest end on persist", async () => {
    const { storage, store } = memoryStorage()
    const registry = await createRegistry(storage)

    const writes: Promise<void>[] = []
    for (let i = 0; i <= 200; i += 1) writes.push(registry.record(`lead-${i}`, `sk-${i}`))

    // Pruning happens in memory even though the writes are queued.
    assert.equal(registry.current("lead-0"), undefined)
    assert.equal(registry.current("lead-1"), "sk-1")
    assert.deepEqual(registry.sessions("lead-0"), [])
    assert.deepEqual(registry.sessions("lead-1"), ["sk-1"])

    await Promise.all(writes)
    const children = store.get(CHILDREN) as Record<string, string>
    const history = store.get(HISTORY) as Record<string, string[]>
    assert.equal(Object.keys(children).length, 200)
    assert.equal(Object.keys(history).length, 200)
    assert.equal(children["lead-0"], undefined)
    assert.equal(history["lead-0"], undefined)
  })
})

describe("reset", () => {
  it("drops the current child but keeps history reachable", async () => {
    const { storage } = memoryStorage()
    const registry = await createRegistry(storage)

    await registry.record("lead", "sk1")
    await registry.record("lead", "sk2")
    await registry.reset("lead")

    assert.equal(registry.current("lead"), undefined)
    assert.deepEqual(registry.sessions("lead"), ["sk1", "sk2"])
  })
})

describe("forget", () => {
  it("removes the session id everywhere and reports whether anything changed", async () => {
    const { storage } = memoryStorage({
      [CHILDREN]: { lead1: "sk1", sk1: "childX", lead2: "sk2" },
      [HISTORY]: {
        lead1: ["sk0", "sk1"],
        sk1: ["a", "b"],
        lead3: ["sk1"],
        lead4: ["sk1", "skX"],
        lead2: ["sk2"],
        // Duplicate entries (possible in a hand-edited persisted blob) all go.
        lead5: ["sk1", "sk1", "skX"],
      },
    })
    const registry = await createRegistry(storage)

    assert.equal(await registry.forget("sk1"), true)
    // As a child value and as a lead key.
    assert.equal(registry.current("lead1"), undefined)
    assert.equal(registry.current("sk1"), undefined)
    // Pruned from history lists; the emptied list is dropped.
    assert.deepEqual(registry.sessions("lead1"), ["sk0"])
    assert.deepEqual(registry.sessions("lead3"), [])
    assert.deepEqual(registry.sessions("lead4"), ["skX"])
    assert.deepEqual(registry.sessions("lead2"), ["sk2"])
    assert.deepEqual(registry.sessions("lead5"), ["skX"])

    assert.equal(await registry.forget("sk1"), false)
    assert.equal(await registry.forget("missing"), false)
  })

  it("persists the pruned maps", async () => {
    const { storage, store } = memoryStorage({
      [CHILDREN]: { lead1: "sk1" },
      [HISTORY]: { lead1: ["sk0", "sk1"] },
    })
    const registry = await createRegistry(storage)

    assert.equal(await registry.forget("sk1"), true)

    assert.deepEqual(store.get(CHILDREN), {})
    assert.deepEqual(store.get(HISTORY), { lead1: ["sk0"] })
  })
})

describe("sessions", () => {
  it("merges history with the current child, history first", async () => {
    const { storage } = memoryStorage({
      [CHILDREN]: { lead: "sk-live" },
      [HISTORY]: { lead: ["sk-old"] },
    })
    const registry = await createRegistry(storage)

    assert.deepEqual(registry.sessions("lead"), ["sk-old", "sk-live"])
    assert.deepEqual(registry.sessions("unknown"), [])
  })

  it("returns history alone when there is no current child", async () => {
    const { storage } = memoryStorage({ [HISTORY]: { lead: ["sk-old", "sk-new"] } })
    const registry = await createRegistry(storage)

    assert.equal(registry.current("lead"), undefined)
    assert.deepEqual(registry.sessions("lead"), ["sk-old", "sk-new"])
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
    assert.deepEqual(reloaded.sessions("lead"), ["sk1", "sk2"])
    assert.deepEqual(reloaded.sessions("lone"), ["sk3"])
  })

  it("persists a reset: the child drops, history keeps the session", async () => {
    const { storage, store } = memoryStorage()
    const registry = await createRegistry(storage)
    await registry.record("lead", "sk1")
    await registry.record("lead", "sk2")
    await registry.reset("lead")

    assert.deepEqual(store.get(CHILDREN), {})
    assert.deepEqual(store.get(HISTORY), { lead: ["sk1", "sk2"] })

    const reloaded = await createRegistry(storage)
    assert.equal(reloaded.current("lead"), undefined)
    assert.deepEqual(reloaded.sessions("lead"), ["sk1", "sk2"])
  })

  it("skips the write when there is nothing to change", async () => {
    const { storage, store } = memoryStorage()
    const registry = await createRegistry(storage)
    await registry.reset("unknown")
    assert.equal(await registry.forget("unknown"), false)
    await settle()

    assert.equal(store.get(CHILDREN), undefined)
    assert.equal(store.get(HISTORY), undefined)
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
    assert.deepEqual(store.get(HISTORY), { lead: ["sk1", "sk2"] })
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
    assert.deepEqual(store.get(HISTORY), { lead: ["sk1", "sk2"] })
  })
})
