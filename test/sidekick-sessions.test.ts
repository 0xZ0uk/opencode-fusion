import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LEAD_SESSION_KEY, createSidekickSessions, type SessionHost } from "../src/sidekick-sessions.ts"
import { createRegistry, type SidekickStorage } from "../src/registry.ts"
import { sidekickSessions } from "../src/sidekick-state.ts"
import type { FusionPair, HostModel } from "../src/pair.ts"

const SIDEKICK_AGENT = "fusion-sidekick"

const PAIR: FusionPair = {
  lead: { providerID: "leadco", modelID: "big", variant: "high" },
  sidekick: { providerID: "cheap", modelID: "small" },
  leadAgent: "fusion-lead",
  sidekickAgent: SIDEKICK_AGENT,
}

const hostModel = (modelID: string, variant?: string): HostModel => ({ id: modelID, providerID: "cheap", ...(variant ? { variant } : {}) })

/** Storage seam fake: writes are applied synchronously, reads are async. */
function memoryStorage() {
  const store = new Map<string, unknown>()
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

type Session = { archived: boolean; model?: HostModel }

/**
 * SessionHost fake. `get` replays `sessions` (a throw means the read failed);
 * `create` hands out the next id from `created` and records the request.
 */
function fakeHost(options: { sessions?: Record<string, Session | Error> } = {}) {
  const sessions: Record<string, Session | Error> = { ...options.sessions }
  const creates: Array<{ agent: string; model?: HostModel; title: string; metadata: Record<string, string> }> = []
  const switches: Array<{ sessionID: string; model: HostModel }> = []
  const gets: string[] = []
  // Start past every seeded id, so a created session never collides with one.
  let counter = Object.keys(sessions).reduce((max, id) => Math.max(max, Number(id.replace("sk-", "")) || 0), 0)

  const host: SessionHost = {
    async get(sessionID) {
      gets.push(sessionID)
      const session = sessions[sessionID]
      if (session instanceof Error) throw session
      return session
    },
    async create(input) {
      creates.push(input)
      counter += 1
      const id = `sk-${counter}`
      // A created session is live, on the model it was created with.
      sessions[id] = { archived: false, ...(input.model ? { model: input.model } : {}) }
      return { id }
    },
    async switchModel(input) {
      switches.push(input)
      const session = sessions[input.sessionID]
      if (session && !(session instanceof Error)) session.model = input.model
    },
  }
  return { host, sessions, creates, switches, gets }
}

/**
 * The real registry over an in-memory storage, so the reuse policy is exercised
 * end to end. `pair: null` means "no pair picked yet".
 */
async function build(
  host: SessionHost,
  options: { pair?: FusionPair | null; seed?: Record<string, unknown> } = {},
) {
  const pair = options.pair === null ? undefined : (options.pair ?? PAIR)
  const seed = options.seed
  const { storage, store } = memoryStorage()
  for (const [key, value] of Object.entries(seed ?? {})) await storage.set(key, value)
  const registry = await createRegistry(storage)
  const sessions = createSidekickSessions({
    host,
    registry,
    sidekickAgent: SIDEKICK_AGENT,
    currentPair: () => pair,
  })
  return { sessions, registry, storage, store }
}

const CHILDREN = "sidekick-sessions"

describe("ensure", () => {
  it("creates a sidekick session on the sidekick agent, named after the pair, and records it", async () => {
    const { host, creates } = fakeHost()
    const { sessions, store } = await build(host)

    assert.equal(await sessions.ensure("lead-1"), "sk-1")

    assert.deepEqual(creates, [
      {
        agent: SIDEKICK_AGENT,
        model: hostModel("small"),
        title: "Fusion sidekick · small",
        metadata: { fusionLeadSession: "lead-1" },
      },
    ])
    // The mapping is persisted before ensure resolves.
    assert.deepEqual(store.get(CHILDREN), { "lead-1": "sk-1" })
    assert.equal(sessions.current("lead-1"), "sk-1")
  })

  it("creates without a model or a titled pair when no pair is picked yet", async () => {
    const { host, creates } = fakeHost()
    const { sessions } = await build(host, { pair: null })

    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.deepEqual(creates, [
      { agent: SIDEKICK_AGENT, title: "Fusion sidekick", metadata: { fusionLeadSession: "lead-1" } },
    ])
  })

  it("reuses the remembered session and does not read the pair's model into it", async () => {
    const { host, creates, switches, gets } = fakeHost({
      sessions: { "sk-1": { archived: false, model: hostModel("small") } },
    })
    const { sessions } = await build(host, { seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-1")

    assert.deepEqual(gets, ["sk-1"])
    assert.equal(creates.length, 0)
    assert.equal(switches.length, 0)
  })

  it("awaits the LRU touch before reusing the session", async () => {
    const { host } = fakeHost({
      sessions: { "sk-1": { archived: false, model: hostModel("small") } },
    })
    // Storage whose writes stay pending, so a read-during-touch would be visible.
    const store = new Map<string, unknown>([[CHILDREN, { "lead-1": "sk-1" }]])
    const pending: Array<() => void> = []
    const storage: SidekickStorage = {
      get: async (key) => store.get(key),
      set: () => new Promise<void>((resolve) => pending.push(() => { store.set(CHILDREN, { "lead-1": "sk-1" }); resolve() })),
    }
    const registry = await createRegistry(storage)
    const sessions = createSidekickSessions({
      host,
      registry,
      sidekickAgent: SIDEKICK_AGENT,
      currentPair: () => PAIR,
    })

    let done = false
    const reused = sessions.ensure("lead-1").then((id) => {
      done = true
      return id
    })
    // The write is queued, so the session is not handed back yet.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(done, false)
    assert.equal(pending.length, 1)

    pending[0]?.()
    assert.equal(await reused, "sk-1")
    assert.equal(done, true)
  })

  it("recreates when the remembered session is archived", async () => {
    const { host, creates, switches } = fakeHost({
      sessions: { "sk-1": { archived: true, model: hostModel("small") } },
    })
    const { sessions, store } = await build(host, { seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-2")
    assert.equal(creates.length, 1)
    assert.equal(switches.length, 0)
    // The archived mapping is dropped, the new one recorded.
    assert.deepEqual(store.get(CHILDREN), { "lead-1": "sk-2" })
  })

  it("recreates when reading the remembered session throws", async () => {
    const { host, creates } = fakeHost({ sessions: { "sk-1": new Error("no such session") } })
    const { sessions, store } = await build(host, { seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-2")
    assert.equal(creates.length, 1)
    assert.deepEqual(store.get(CHILDREN), { "lead-1": "sk-2" })
  })

  it("re-syncs a reused session whose model no longer matches the pair", async () => {
    const { host, creates, switches } = fakeHost({
      sessions: { "sk-1": { archived: false, model: { id: "old", providerID: "cheap" } } },
    })
    const { sessions } = await build(host, { seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.equal(creates.length, 0)
    assert.deepEqual(switches, [{ sessionID: "sk-1", model: hostModel("small") }])
  })

  it("re-syncs when the reused session reports no model at all", async () => {
    const { host, switches } = fakeHost({ sessions: { "sk-1": { archived: false } } })
    const { sessions } = await build(host, { seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.deepEqual(switches, [{ sessionID: "sk-1", model: hostModel("small") }])
  })

  it("leaves a reused session alone when the pair matches it exactly", async () => {
    const { host, switches } = fakeHost({
      sessions: { "sk-1": { archived: false, model: hostModel("small", "max") } },
    })
    const pair: FusionPair = { ...PAIR, sidekick: { ...PAIR.sidekick, variant: "max" } }
    const { sessions } = await build(host, { pair, seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.equal(switches.length, 0)
  })

  it("does not re-sync a reused session when no pair is picked yet", async () => {
    const { host, switches } = fakeHost({
      sessions: { "sk-1": { archived: false, model: { id: "whatever", providerID: "cheap" } } },
    })
    const { sessions } = await build(host, { pair: null, seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.equal(switches.length, 0)
  })

  /**
   * The reader in sidekick-state.ts matches sessions on this key, so writer and
   * reader must not drift. It imports the constant from this module; this test
   * pins the literal that the host actually sees in session metadata.
   */
  it("stamps the lead marker the sidekick-state reader filters on", async () => {
    const { host, creates } = fakeHost()
    const { sessions } = await build(host)

    await sessions.ensure("lead-1")

    assert.equal(LEAD_SESSION_KEY, "fusionLeadSession")
    assert.equal(creates[0]?.metadata[LEAD_SESSION_KEY], "lead-1")
    // A sidekick stamped by this module is one the reader finds.
    assert.deepEqual(sidekickSessions([{ id: "sk-1", status: "idle", metadata: creates[0]?.metadata }], "lead-1"), ["sk-1"])
  })

  it("reads the pair late, so a re-pair after setup is honoured", async () => {
    const { host, switches } = fakeHost({
      sessions: { "sk-1": { archived: false, model: hostModel("small") } },
    })
    const { storage } = memoryStorage()
    const registry = await createRegistry(storage)
    await registry.record("lead-1", "sk-1")

    let pair: FusionPair | undefined = undefined
    const sessions = createSidekickSessions({
      host,
      registry,
      sidekickAgent: SIDEKICK_AGENT,
      currentPair: () => pair,
    })
    // No pair at build time: nothing to re-sync to.
    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.equal(switches.length, 0)

    // setPair lands later; the next reuse re-syncs to the new sidekick.
    pair = { ...PAIR, sidekick: { providerID: "cheap", modelID: "newer" } }
    assert.equal(await sessions.ensure("lead-1"), "sk-1")
    assert.deepEqual(switches, [{ sessionID: "sk-1", model: hostModel("newer") }])
  })

  it("keeps leads apart", async () => {
    const { host } = fakeHost()
    const { sessions } = await build(host)

    const first = await sessions.ensure("lead-1")
    const second = await sessions.ensure("lead-2")
    assert.notEqual(first, second)
    assert.equal(sessions.current("lead-1"), first)
    assert.equal(sessions.current("lead-2"), second)
  })
})

describe("forget", () => {
  it("drops the lead's current sidekick, and the next ensure creates a new one", async () => {
    const { host, creates } = fakeHost({
      sessions: { "sk-1": { archived: false, model: hostModel("small") } },
    })
    const { sessions } = await build(host, { seed: { [CHILDREN]: { "lead-1": "sk-1" } } })

    await sessions.forget("lead-1")
    assert.equal(sessions.current("lead-1"), undefined)

    assert.equal(await sessions.ensure("lead-1"), "sk-2")
    assert.equal(creates.length, 1)
  })
})
