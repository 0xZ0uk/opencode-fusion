import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Plugin } from "@opencode/plugin/tui"
import { startStatusLifecycle, type StatusLineStore } from "../src/status-lifecycle.ts"
import { createTuiRuntime, type TuiRuntime } from "../src/tui-runtime.ts"
import type { FusionClient, PairStatus, PairChanged } from "../src/rpc.ts"
import type { FusionPair } from "../src/pair.ts"
import type { SidekickSession } from "../src/sidekick-state.ts"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Polls until the lifecycle's async work has landed, so the tests never race it. */
const until = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  assert.fail(`timed out waiting for ${label}`)
}

const PAIR: FusionPair = {
  lead: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
  sidekick: { providerID: "openai", modelID: "gpt-5.6-luna" },
  leadAgent: "fusion",
  sidekickAgent: "sidekick",
}

const status = (overrides: Partial<PairStatus> = {}): PairStatus => ({
  configured: true,
  pair: PAIR,
  leadAgent: "fusion",
  sidekickAgent: "sidekick",
  ...overrides,
})

const SESSION_EVENTS = [
  "session.created",
  "session.deleted",
  "session.metadata.updated",
  "session.status",
  "session.idle",
  "session.agent.selected",
  "session.model.selected",
]

type SessionRow = { id: string; metadata?: Record<string, unknown>; archived?: number; status: string }

type MemoryStore = { pair?: FusionPair; leadAgent: string; sessionsVersion: number }

/**
 * A structural `Plugin.Context` holding only what the lifecycle reads: the
 * memory store, the session list with its separate run status, and the event
 * bus. The memory setter applies the draft mutation to the live object, which
 * is what the host's store does for these mutations.
 *
 * `captureWarnings` replaces `console.warn` only for the tests that assert on
 * it, and `release` puts the real one back — the default path never touches the
 * global at all.
 */
function fakeContext(sessions: SessionRow[] = [], options: { captureWarnings?: boolean } = {}) {
  const handlers = new Map<string, Set<() => void>>()
  const memoryCalls: string[] = []
  const warnings: string[] = []
  const realWarn = console.warn
  if (options.captureWarnings) console.warn = (message: unknown) => void warnings.push(String(message))

  const context = {
    storage: {
      memory: (key: string, options: { initial: MemoryStore }) => {
        memoryCalls.push(key)
        const store: MemoryStore = { ...options.initial }
        return [store, (mutation: (draft: MemoryStore) => void) => mutation(store)] as const
      },
    },
    data: {
      session: {
        list: () => sessions.map((row) => ({ id: row.id, metadata: row.metadata, time: { archived: row.archived } })),
        status: (id: string) => sessions.find((row) => row.id === id)?.status ?? "idle",
      },
      on: (type: string, handler: () => void) => {
        const registered = handlers.get(type) ?? new Set()
        registered.add(handler)
        handlers.set(type, registered)
        return () => registered.delete(handler)
      },
    },
  } as unknown as Plugin.Context

  return {
    context,
    memoryCalls,
    warnings,
    /** Fires whatever is still subscribed to `type`; a no-op once released. */
    fire: (type: string) => {
      for (const handler of handlers.get(type) ?? []) handler()
    },
    listeners: (type: string) => handlers.get(type)?.size ?? 0,
    release: () => {
      if (options.captureWarnings) console.warn = realWarn
    },
  }
}

type PendingRead = {
  resolve: (value: PairStatus) => void
  reject: (error: unknown) => void
}

function fakeFusion(options: { failEventOn?: boolean } = {}) {
  const reads: PendingRead[] = []
  const listeners = new Set<(data: PairChanged) => void>()

  const client: FusionClient = {
    getPair: () =>
      new Promise<PairStatus>((resolve, reject) => {
        reads.push({ resolve, reject })
      }),
    setPair: async () => status(),
    apply: async () => ({ applied: true }),
    events: {
      on: (_name, handler) => {
        if (options.failEventOn) throw new Error("event bus refused")
        const entry = handler as (data: PairChanged) => void
        listeners.add(entry)
        return () => void listeners.delete(entry)
      },
    },
  }

  return {
    client,
    reads,
    listeners,
    emit: (data: PairChanged) => {
      for (const handler of listeners) handler(data)
    },
    settle: async (index: number, value: PairStatus) => {
      const read = reads[index]
      assert.ok(read, `no getPair read at index ${index}`)
      read.resolve(value)
      await tick()
    },
  }
}

/** Starts a lifecycle on a fresh runtime; the returned `stop` tears both down. */
function start(host: ReturnType<typeof fakeContext>, fusion: ReturnType<typeof fakeFusion>) {
  const runtime = createTuiRuntime()
  const lifecycle = startStatusLifecycle({ context: host.context, fusion: fusion.client, runtime })
  return {
    runtime,
    lifecycle,
    stop: async () => {
      lifecycle.dispose()
      await runtime.dispose()
      host.release()
    },
  }
}

describe("status lifecycle startup", () => {
  it("seeds the store from the defaults and applies the pair the server reports", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    try {
      const state = (): StatusLineStore => lifecycle.claim.state
      assert.deepEqual(host.memoryCalls, ["fusion-status"])
      assert.equal(state().pair, undefined)
      assert.equal(state().leadAgent, "fusion")
      assert.equal(state().sessionsVersion, 0)

      await until(() => fusion.reads.length === 1, "the startup read")
      assert.equal(fusion.listeners.size, 1, "pairChanged is subscribed before the first read is answered")
      await fusion.settle(0, status())
      await until(() => state().pair !== undefined, "the startup pair")
      assert.equal(state().pair?.lead.modelID, "gpt-5.6-sol")
      assert.equal(state().leadAgent, "fusion")
    } finally {
      await stop()
    }
  })

  it("bumps the session revision for each of the seven session events", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    try {
      for (const [index, type] of SESSION_EVENTS.entries()) {
        host.fire(type)
        assert.equal(lifecycle.claim.state.sessionsVersion, index + 1, `after ${type}`)
      }
    } finally {
      await stop()
    }
  })
})

describe("status lifecycle refresh", () => {
  it("re-reads the pair when the server announces pairChanged", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    try {
      await fusion.settle(0, status())
      await until(() => lifecycle.claim.state.pair !== undefined, "the startup pair")

      fusion.emit(PAIR)
      await until(() => fusion.reads.length === 2, "the pairChanged read")
      await fusion.settle(
        1,
        status({ pair: { ...PAIR, lead: { providerID: "openai", modelID: "fresh" } }, leadAgent: "my-lead" }),
      )
      await until(() => lifecycle.claim.state.pair?.lead.modelID === "fresh", "the refreshed pair")
      assert.equal(lifecycle.claim.state.leadAgent, "my-lead")
    } finally {
      await stop()
    }
  })

  it("drops a stale read that a newer one overtook", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    try {
      await fusion.settle(0, status())
      await until(() => lifecycle.claim.state.pair !== undefined, "the startup pair")

      fusion.emit(PAIR)
      await until(() => fusion.reads.length === 2, "the first pairChanged read")
      fusion.emit(PAIR)
      await until(() => fusion.reads.length === 3, "the second pairChanged read")

      await fusion.settle(2, status({ pair: { ...PAIR, lead: { providerID: "openai", modelID: "fresh" } } }))
      await until(() => lifecycle.claim.state.pair?.lead.modelID === "fresh", "the newest pair")

      // The slow read the newer one overtook must not resurrect what it read.
      await fusion.settle(1, status({ pair: { ...PAIR, lead: { providerID: "openai", modelID: "stale" } } }))
      assert.equal(lifecycle.claim.state.pair?.lead.modelID, "fresh")
    } finally {
      await stop()
    }
  })

  it("falls back to no pair when the server plugin is unreachable", async () => {
    const host = fakeContext([], { captureWarnings: true })
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    try {
      await until(() => fusion.reads.length === 1, "the startup read")
      fusion.reads[0].reject(new Error("connection refused"))
      await until(() => host.warnings.length > 0, "the unreachable warning")
      assert.match(host.warnings[0], /server plugin unreachable: Error: connection refused/)
      assert.equal(lifecycle.claim.state.pair, undefined)
      assert.equal(lifecycle.claim.state.leadAgent, "fusion")
    } finally {
      await stop()
    }
  })
})

describe("status lifecycle session snapshot", () => {
  it("merges the host's separate run status into every session", async () => {
    const host = fakeContext([
      { id: "ses_lead", status: "idle" },
      { id: "ses_kick", metadata: { fusionLeadSession: "ses_lead" }, status: "running" },
      { id: "ses_old", metadata: { fusionLeadSession: "ses_lead" }, archived: 1, status: "idle" },
    ])
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    try {
      const sessions: readonly SidekickSession[] = lifecycle.claim.sessions()
      assert.deepEqual(sessions, [
        { id: "ses_lead", metadata: undefined, time: { archived: undefined }, status: "idle" },
        {
          id: "ses_kick",
          metadata: { fusionLeadSession: "ses_lead" },
          time: { archived: undefined },
          status: "running",
        },
        { id: "ses_old", metadata: { fusionLeadSession: "ses_lead" }, time: { archived: 1 }, status: "idle" },
      ])
    } finally {
      await stop()
    }
  })
})

describe("status lifecycle disposal", () => {
  it("releases every session subscription and the pairChanged listener", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    await fusion.settle(0, status())
    await until(() => lifecycle.claim.state.pair !== undefined, "the startup pair")

    const version = lifecycle.claim.state.sessionsVersion
    lifecycle.dispose()
    for (const type of SESSION_EVENTS) assert.equal(host.listeners(type), 0, `${type} still subscribed`)
    assert.equal(fusion.listeners.size, 0)

    // Nothing reaches the host or the store once the lifecycle is gone.
    fusion.emit(PAIR)
    for (const type of SESSION_EVENTS) host.fire(type)
    assert.equal(fusion.reads.length, 1)
    assert.equal(lifecycle.claim.state.sessionsVersion, version)

    await stop()
  })

  it("is safe to dispose twice", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, stop } = start(host, fusion)
    lifecycle.dispose()
    lifecycle.dispose()
    assert.equal(fusion.listeners.size, 0)
    await stop()
  })

  it("never applies a read still pending when the lifecycle is disposed", async () => {
    // The runtime outlives the lifecycle here on purpose: the pending read
    // still resolves into a live runtime, so only the lifecycle's own guard can
    // keep it out of the store.
    const host = fakeContext()
    const fusion = fakeFusion()
    const { lifecycle, runtime, stop } = start(host, fusion)
    try {
      await until(() => fusion.reads.length === 1, "the startup read")
      lifecycle.dispose()
      assert.equal(runtime.isDisposed(), false, "the runtime is still alive to run the read")

      await fusion.settle(0, status())
      assert.equal(lifecycle.claim.state.pair, undefined, "a disposed lifecycle applied a late read")
      assert.equal(lifecycle.claim.state.leadAgent, "fusion")
    } finally {
      await stop()
    }
  })

  it("releases the subscriptions it already took when a registration throws", async () => {
    const host = fakeContext()
    const fusion = fakeFusion({ failEventOn: true })
    const runtime = createTuiRuntime()
    try {
      assert.throws(
        () => startStatusLifecycle({ context: host.context, fusion: fusion.client, runtime }),
        /event bus refused/,
      )
      // The seven session subscriptions were taken before the pairChanged one
      // threw, so they must be back off the bus rather than leaked by a
      // construction that never returned a disposer.
      for (const type of SESSION_EVENTS) assert.equal(host.listeners(type), 0, `${type} still subscribed`)
      assert.equal(fusion.listeners.size, 0)
      assert.equal(fusion.reads.length, 0, "the first refresh must not have started")
    } finally {
      await runtime.dispose()
      host.release()
    }
  })

  it("releases through the runtime scope when the lifecycle is registered there", async () => {
    const host = fakeContext()
    const fusion = fakeFusion()
    const runtime: TuiRuntime = createTuiRuntime()
    const lifecycle = startStatusLifecycle({ context: host.context, fusion: fusion.client, runtime })
    runtime.register(lifecycle, (started) => started.dispose())
    await fusion.settle(0, status())
    await until(() => lifecycle.claim.state.pair !== undefined, "the startup pair")

    await runtime.dispose()
    host.release()
    assert.equal(fusion.listeners.size, 0)
    for (const type of SESSION_EVENTS) assert.equal(host.listeners(type), 0, `${type} still subscribed`)
    assert.equal(runtime.isDisposed(), true)
  })
})
