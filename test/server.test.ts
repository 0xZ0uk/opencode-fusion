import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Plugin } from "@opencode/plugin/effect"
import { Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Scope, Stream } from "effect"
import { fusionSetup } from "../src/setup.ts"
import type { SetupDeps } from "../src/setup.ts"

function fakeCtx(options: {
  pluginOptions?: unknown
  failToolTransform?: boolean
  failPermission?: boolean
  events?: Array<Record<string, unknown>>
  gateWritesAfter?: number
} = {}) {
  const released: string[] = []
  const registered = (name: string) => <A>(acquire: Effect.Effect<A>) =>
    Effect.acquireRelease(acquire, () => Effect.sync(() => released.push(name)))

  const store = new Map<string, unknown>()
  const agents = new Map<string, { id: string; model?: unknown; system?: unknown; permissions?: unknown[]; mode?: string }>([
    ["fusion", { id: "fusion", permissions: [] }],
    ["sidekick", { id: "sidekick", permissions: [] }],
  ])
  const agentTransforms: Array<(editor: unknown) => void> = []
  let reloads = 0
  let lists = 0
  const emits: Array<{ name: string; data: unknown }> = []
  const rpcHandlers = new Map<string, (input: unknown) => Effect.Effect<unknown>>()
  const permissionHooks: Array<(event: { agent?: unknown; action: string; resources: string[]; effect?: string; message?: string }) => Effect.Effect<void>> = []
  const toolEditors: unknown[] = []
  const toolsAdded: Array<{ execute: (input: unknown, context: unknown) => Effect.Effect<unknown> }> = []
  const progressUpdates: unknown[] = []
  const pendingWrites: Array<{ key: string; release(): void }> = []
  let writeCalls = 0
  const eventGate = Effect.runSync(Deferred.make<void>())
  let subscribeReleased = false

  const editor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    update: (id: string, fn: (agent: never) => void) => {
      const agent = agents.get(id)
      if (agent) fn(agent as never)
    },
    remove: (id: string) => {
      agents.delete(id)
    },
    default: () => {},
  }

  const ctx = {
    app: { version: "2.0.19" },
    options: options.pluginOptions ?? {},
    storage: {
      get: (key: string) => Effect.succeed(store.get(key)),
      set: (key: string, value: unknown) => {
        writeCalls += 1
        return options.gateWritesAfter !== undefined && writeCalls > options.gateWritesAfter
          ? Effect.callback<void>((resume) => {
              pendingWrites.push({
                key,
                release: () => {
                  store.set(key, value)
                  resume(Effect.void)
                },
              })
            })
          : Effect.sync(() => void store.set(key, value))
      },
    },
    agent: {
      transform: (cb: (e: any) => void) =>
        registered("agent.transform")(
          Effect.sync(() => {
            agentTransforms.push(cb)
            cb(editor)
            return { dispose: Effect.void }
          }),
        ),
      list: () =>
        Effect.sync(() => {
          lists += 1
          return { data: [...agents.values()].map((agent) => ({ id: agent.id })) }
        }),
      reload: () =>
        Effect.sync(() => {
          reloads += 1
          for (const cb of agentTransforms) cb(editor)
        }),
    },
    session: {
      prompt: () => Effect.succeed({ id: "inbox-1" }),
      wait: () => Effect.never,
      context: () => Effect.succeed([]),
      interrupt: () => Effect.succeed({ interrupted: true }),
      synthetic: () => Effect.void,
      get: () => Effect.fail(new Error("no session")),
      create: () => Effect.succeed({ id: "sk-new" }),
      switchModel: () => Effect.void,
    },
    vcs: { diff: () => Effect.succeed({ data: [] }) },
    tool: {
      transform: (cb: (e: unknown) => void) => {
        if (options.failToolTransform) return Effect.fail(new Error("tool transform down"))
        return registered("tool.transform")(
          Effect.sync(() => {
            const te = {
              namespace: () => {},
              add: (tool: { execute: (input: unknown, context: unknown) => Effect.Effect<unknown> }) => toolsAdded.push(tool),
              update: () => {},
              remove: () => {},
              list: () => [],
              get: () => undefined,
            }
            toolEditors.push(te)
            cb(te)
            return { dispose: Effect.void }
          }),
        )
      },
    },
    permission: {
      hook: (name: string, cb: (event: { agent?: unknown; action: string; resources: string[]; effect?: string; message?: string }) => Effect.Effect<void>) =>
        options.failPermission
          ? Effect.fail(new Error("permission hook down"))
          : registered("permission.hook")(
              Effect.sync(() => {
                permissionHooks.push(cb)
                return { dispose: Effect.void }
              }),
            ),
    },
    rpc: {
      register: (definition: { methods: Record<string, unknown> }, handlers: Record<string, (input: unknown) => Effect.Effect<unknown>>) =>
        registered("rpc.register")(
          Effect.sync(() => {
            for (const [name, handler] of Object.entries(handlers)) rpcHandlers.set(name, handler)
            return {
              dispose: Effect.void,
              events: {
                emit: (name: string, data: unknown) => Effect.sync(() => emits.push({ name, data })),
              },
            }
          }),
        ),
    },
    event: {
      subscribe: () =>
        Stream.unwrap(
          Effect.map(Deferred.await(eventGate), () =>
            Stream.fromIterable((options.events ?? []) as never[]).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(Effect.sync(() => (subscribeReleased = true))),
            ),
          ),
        ),
    },
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    store,
    agents,
    released,
    emits,
    rpcHandlers,
    permissionHooks,
    toolsAdded,
    reloads: () => reloads,
    lists: () => lists,
    pendingWrites,
    progressUpdates,
    fireEvents: () => Effect.runSync(Deferred.complete(eventGate, Effect.void)),
    replayAgents: () => {
      for (const cb of agentTransforms) cb(editor)
    },
    subscribeReleased: () => subscribeReleased,
  }
}

const deps: SetupDeps = {
  toolError: (message, error) => Object.assign(new Error(message), { cause: error }) as never,
  trace: () => {},
}

describe("service composition", () => {
  it("builds each service once and shares it across registrations", async () => {
    const t = fakeCtx({ pluginOptions: { leadAgent: "lead-z", sidekickAgent: "sk-z" } })
    const scope = Effect.runSync(Scope.make())
    const runtime = ManagedRuntime.make(Layer.empty)
    const storeGet = t.store.get.bind(t.store)
    let storageReads = 0
    t.agents.set("lead-z", { id: "lead-z", permissions: [] })
    t.agents.set("sk-z", { id: "sk-z", permissions: [] })
    const patched = {
      ...t.ctx,
      storage: {
        get: (key: string) => {
          storageReads += 1
          return Effect.succeed(storeGet(key))
        },
        set: t.ctx.storage.set,
      },
    } as unknown as Plugin.Context
    await runtime.runPromise(Effect.provideService(fusionSetup(patched, deps), Scope.Scope, scope))

    const setPair = t.rpcHandlers.get("setPair")
    assert.ok(setPair)
    await runtime.runPromise(
      setPair({
        lead: { providerID: "leadco", modelID: "big" },
        sidekick: { providerID: "cheap", modelID: "small" },
      }),
    )
    t.replayAgents()
    assert.deepEqual(t.agents.get("lead-z")?.model, { id: "big", providerID: "leadco" })
    assert.deepEqual(t.agents.get("sk-z")?.model, { id: "small", providerID: "cheap" })
    assert.equal(storageReads, 2, "registry and pair each read their key once")
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await runtime.dispose()
  })
})

const runtime = ManagedRuntime.make(Layer.empty)
const run = (ctx: Plugin.Context, scope: Scope.Closeable) =>
  runtime.runPromise(Effect.provideService(fusionSetup(ctx, deps), Scope.Scope, scope))

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("fusionSetup", () => {
  it("registers transform, tools, permission hook, rpc and releases them all on unload", async () => {
    const t = fakeCtx()
    const scope = Effect.runSync(Scope.make())
    await run(t.ctx, scope)

    assert.equal(t.toolsAdded.length, 1)
    assert.equal(t.permissionHooks.length, 1)
    assert.deepEqual(t.released, [])

    await sleep(50)
    t.fireEvents()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    assert.deepEqual(
      [...t.released].sort(),
      ["agent.transform", "permission.hook", "rpc.register", "tool.transform"],
    )
    assert.equal(t.subscribeReleased(), true, "event consumer stopped")
  })

  it("omits the late pass entirely when the scope closes before it", async () => {
    const t = fakeCtx()
    const scope = Effect.runSync(Scope.make())
    await run(t.ctx, scope)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const lists = t.lists()
    await sleep(500)
    assert.equal(t.lists(), lists)
  })

  it("cleans earlier registrations when a later registration fails", async () => {
    const t = fakeCtx({ failToolTransform: true })
    const scope = Effect.runSync(Scope.make())
    await assert.rejects(run(t.ctx, scope))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    assert.deepEqual(t.released, ["agent.transform"])
  })

  it("transform leaves models alone until a pair is picked, then applies on reload", async () => {
    const t = fakeCtx()
    const scope = Effect.runSync(Scope.make())
    await run(t.ctx, scope)

    assert.equal(t.agents.get("fusion")?.model, undefined)
    assert.equal(t.agents.get("sidekick")?.model, undefined)
    assert.equal(t.agents.get("fusion")?.system !== undefined, true)
    assert.equal(t.agents.get("sidekick")?.mode, "subagent")

    const setPair = t.rpcHandlers.get("setPair")
    assert.ok(setPair)
    await Effect.runPromise(
      setPair({
        lead: { providerID: "leadco", modelID: "big" },
        sidekick: { providerID: "cheap", modelID: "small" },
      }),
    )

    assert.equal(t.reloads(), 1)
    assert.deepEqual(t.agents.get("fusion")?.model, { id: "big", providerID: "leadco" })
    assert.deepEqual(t.agents.get("sidekick")?.model, { id: "small", providerID: "cheap" })
    assert.deepEqual(t.emits, [
      { name: "pairChanged", data: { lead: { providerID: "leadco", modelID: "big" }, sidekick: { providerID: "cheap", modelID: "small" } } },
    ])
    assert.deepEqual(t.store.get("pair"), {
      lead: { providerID: "leadco", modelID: "big" },
      sidekick: { providerID: "cheap", modelID: "small" },
      leadAgent: "fusion",
      sidekickAgent: "sidekick",
    })

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("runs the late drift pass once agents are listed", async () => {
    const t = fakeCtx()
    const scope = Effect.runSync(Scope.make())
    t.store.set("pair", {
      lead: { providerID: "leadco", modelID: "big" },
      sidekick: { providerID: "cheap", modelID: "small" },
      leadAgent: "fusion",
      sidekickAgent: "sidekick",
    })
    await run(t.ctx, scope)
    const before = t.lists()
    await sleep(600)
    assert.ok(t.lists() > before, "the 400ms late pass listed agents")
    assert.ok(t.reloads() >= 1)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("processes step events without blocking on a queued session.deleted write", async () => {
    const t = fakeCtx({
      gateWritesAfter: 1,
      events: [
        { type: "session.deleted", data: { sessionID: "sk-new" } },
        { type: "session.step.ended", data: { sessionID: "sk-new", files: ["a.ts"] } },
      ],
    })
    const scope = Effect.runSync(Scope.make())
    await run(t.ctx, scope)

    const tool = t.toolsAdded[0]
    assert.ok(tool)
    const toolCtx = {
      agent: "fusion",
      sessionID: "lead-1",
      progress: (update: unknown) => Effect.sync(() => void t.progressUpdates.push(update)),
    }
    const delegated = Effect.runFork(tool.execute({ message: "work" }, toolCtx) as Effect.Effect<{ content: string }>)
    await sleep(30)

    t.fireEvents()
    await sleep(50)
    assert.equal(t.pendingWrites.length, 1, "the forget write is queued and gated")

    const step = t.progressUpdates.find((u) => String((u as { title?: string }).title).startsWith("sidekick · step"))
    assert.ok(step, "step event fanned out while the forget write was still blocked")

    await Effect.runPromise(Fiber.interrupt(delegated))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await sleep(30)
    assert.equal(t.pendingWrites.length, 1, "the gated write was cancelled, not released")
    assert.deepEqual(t.store.get("sidekick-sessions"), { "lead-1": "sk-new" })
  })

  it("omits the permission hook when enforcement is off", async () => {
    const t = fakeCtx({ pluginOptions: { enforce: "off" } })
    const scope = Effect.runSync(Scope.make())
    await run(t.ctx, scope)
    assert.equal(t.permissionHooks.length, 0)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  it("enforces the policy through the hook for the lead agent only", async () => {
    const t = fakeCtx()
    const scope = Effect.runSync(Scope.make())
    await run(t.ctx, scope)
    const evaluate = t.permissionHooks[0]
    assert.ok(evaluate)

    const denied = { agent: "fusion", action: "edit", resources: ["x.ts"], effect: "allow" as string | undefined }
    await Effect.runPromise(evaluate(denied as never))
    assert.equal(denied.effect, "deny")
    assert.match((denied as { message?: string }).message ?? "", /sidekick/)

    const other = { agent: "not-fusion", action: "edit", resources: ["x.ts"], effect: "allow" as string | undefined }
    await Effect.runPromise(evaluate(other as never))
    assert.equal(other.effect, "allow")

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
