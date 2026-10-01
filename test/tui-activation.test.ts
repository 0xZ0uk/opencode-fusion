import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { activateLead, type ActivationContext, type ActivationRoute } from "../src/tui-activation.ts"
import { createTuiRuntime } from "../src/tui-runtime.ts"
import type { PairStatus } from "../src/rpc.ts"

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const STATUS: PairStatus = {
  configured: true,
  leadAgent: "my-lead",
  sidekickAgent: "sidekick",
  pair: {
    lead: { providerID: "anthropic", modelID: "claude-opus-9", variant: "max" },
    sidekick: { providerID: "openai", modelID: "gpt-5.6-luna" },
    leadAgent: "my-lead",
    sidekickAgent: "sidekick",
  },
}

const LEAD_MODEL = { id: "claude-opus-9", providerID: "anthropic", variant: "max" }

function fakeContext(options: {
  route: ActivationRoute
  location?: { directory: string }
  failCreate?: boolean
  failSwitchAgent?: boolean
  failSwitchModel?: boolean
  failSync?: boolean
  gateCreate?: Promise<void>
}): { ctx: ActivationContext; calls: string[]; createInput: () => unknown } {
  const calls: string[] = []
  let createInput: unknown
  const ctx: ActivationContext = {
    location: options.location,
    client: {
      session: {
        create: async (input) => {
          createInput = input
          calls.push("create")
          if (options.gateCreate) await options.gateCreate
          if (options.failCreate) throw new Error("create failed")
          return { id: "ses_new" }
        },
        switchAgent: async (input) => {
          calls.push(`switchAgent:${input.sessionID}:${input.agent}`)
          if (options.failSwitchAgent) throw new Error("agent failed")
        },
        switchModel: async (input) => {
          calls.push(`switchModel:${input.sessionID}:${JSON.stringify(input.model)}`)
          if (options.failSwitchModel) throw new Error("model failed")
        },
      },
    },
    data: {
      session: {
        sync: async (sessionID) => {
          calls.push(`sync:${sessionID}`)
          if (options.failSync) throw new Error("sync failed")
        },
      },
      location: { default: () => ({ directory: "/default-loc" }) },
    },
    ui: {
      router: {
        current: () => options.route,
        navigate: (destination) => calls.push(`navigate:${destination.sessionID}`),
      },
    },
  }
  return { ctx, calls, createInput: () => createInput }
}

const run = (ctx: ActivationContext, status: PairStatus = STATUS) => Effect.runPromise(activateLead(ctx, status))

describe("activateLead on a session route", () => {
  it("switches agent then model then syncs, in order, on the session in view", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "session", sessionID: "ses_live" } })
    await run(ctx)
    assert.deepEqual(calls, [
      "switchAgent:ses_live:my-lead",
      `switchModel:ses_live:${JSON.stringify(LEAD_MODEL)}`,
      "sync:ses_live",
    ])
  })

  it("stops after a switchAgent failure", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "session", sessionID: "ses_live" }, failSwitchAgent: true })
    await assert.rejects(run(ctx), /agent failed/)
    assert.deepEqual(calls, ["switchAgent:ses_live:my-lead"])
  })

  it("stops after a switchModel failure", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "session", sessionID: "ses_live" }, failSwitchModel: true })
    await assert.rejects(run(ctx), /model failed/)
    assert.deepEqual(calls, ["switchAgent:ses_live:my-lead", `switchModel:ses_live:${JSON.stringify(LEAD_MODEL)}`])
  })

  it("propagates a sync failure", async () => {
    const { ctx } = fakeContext({ route: { type: "session", sessionID: "ses_live" }, failSync: true })
    await assert.rejects(run(ctx), /sync failed/)
  })
})

describe("activateLead on the home route", () => {
  it("creates a lead session with the saved agent, lead model and explicit location, then syncs and navigates", async () => {
    const { ctx, calls, createInput } = fakeContext({ route: { type: "home" }, location: { directory: "/work/dir" } })
    await run(ctx)
    assert.deepEqual(createInput(), {
      agent: "my-lead",
      model: LEAD_MODEL,
      location: { directory: "/work/dir" },
    })
    assert.deepEqual(calls, ["create", "sync:ses_new", "navigate:ses_new"])
  })

  it("falls back to the default location when the context has none", async () => {
    const { ctx, createInput } = fakeContext({ route: { type: "home" } })
    await run(ctx)
    assert.deepEqual((createInput() as { location: unknown }).location, { directory: "/default-loc" })
  })

  it("does not navigate when creation fails", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "home" }, failCreate: true })
    await assert.rejects(run(ctx), /create failed/)
    assert.deepEqual(calls, ["create"])
  })

  it("does not navigate when the sync fails", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "home" }, failSync: true })
    await assert.rejects(run(ctx), /sync failed/)
    assert.deepEqual(calls, ["create", "sync:ses_new"])
  })

  it("suppresses the late sync and navigation when interrupted while creation is pending", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { ctx, calls } = fakeContext({ route: { type: "home" }, gateCreate: gate })
    const runtime = createTuiRuntime()
    const pending = runtime.runPromise(activateLead(ctx, STATUS)).then(
      () => "resolved",
      () => "interrupted",
    )
    await settle()
    await runtime.dispose()
    release()
    assert.equal(await pending, "interrupted")
    await settle()
    assert.deepEqual(calls, ["create"])
  })
})

describe("activateLead elsewhere", () => {
  it("touches nothing on a plugin route", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "plugin" } })
    await run(ctx)
    assert.deepEqual(calls, [])
  })

  it("rejects when the status carries no pair", async () => {
    const { ctx, calls } = fakeContext({ route: { type: "session", sessionID: "ses_live" } })
    await assert.rejects(run(ctx, { configured: false, leadAgent: "my-lead", sidekickAgent: "sidekick" }))
    assert.deepEqual(calls, [])
  })
})
