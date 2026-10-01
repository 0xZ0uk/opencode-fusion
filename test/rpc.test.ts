import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { fusionClient, type PairStatus, type RawFusionClient, type SetPairInput } from "../src/rpc.ts"

type Handler = (event: { readonly data: Readonly<Record<string, unknown>> }) => Promise<void> | void

/**
 * A plain object standing in for `context.client.rpc(Fusion)`: records the
 * inputs it is called with and replays canned `unknown` results, which is
 * exactly what the host hands the adapter.
 */
function fakeRaw() {
  const calls: { method: string; input: unknown }[] = []
  const handlers = new Map<string, Handler[]>()
  const returnValue = <T>(method: string, input: unknown, value: T): Promise<T> => {
    calls.push({ method, input })
    return Promise.resolve(value)
  }
  const raw: RawFusionClient = {
    getPair: (input) => returnValue("getPair", input, { configured: false, leadAgent: "fusion-lead", sidekickAgent: "fusion-sidekick" }),
    setPair: (input) =>
      returnValue("setPair", input, {
        configured: true,
        pair: { ...(input as object), leadAgent: "fusion-lead", sidekickAgent: "fusion-sidekick" },
        leadAgent: "fusion-lead",
        sidekickAgent: "fusion-sidekick",
      }),
    apply: (input) => returnValue("apply", input, { applied: true }),
    sidekicks: (input) => returnValue("sidekicks", input, { current: "ses_side", sessionIDs: ["ses_side"], running: true }),
    events: {
      on: (name, handler) => {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => {
          const live = handlers.get(name) ?? []
          handlers.set(
            name,
            live.filter((entry) => entry !== handler),
          )
        }
      },
    },
  }
  const emit = (name: string, data: Record<string, unknown>) => {
    for (const handler of handlers.get(name) ?? []) handler({ data })
  }
  return { raw, calls, emit }
}

describe("fusionClient", () => {
  it("returns the pair result as a typed value", async () => {
    const { raw } = fakeRaw()
    const fusion = fusionClient(raw)
    const status: PairStatus = await fusion.getPair()
    assert.equal(status.configured, false)
    assert.equal(status.leadAgent, "fusion-lead")
    assert.equal(status.pair, undefined)
    assert.deepEqual(status, { configured: false, leadAgent: "fusion-lead", sidekickAgent: "fusion-sidekick" })
  })

  it("forwards the setPair input and returns the saved pair result", async () => {
    const { raw, calls } = fakeRaw()
    const fusion = fusionClient(raw)
    const input: SetPairInput = {
      lead: { providerID: "openai", modelID: "gpt-5.6-sol" },
      sidekick: { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
    }
    const status = await fusion.setPair(input)
    assert.deepEqual(calls, [{ method: "setPair", input }])
    assert.equal(status.configured, true)
    assert.equal(status.pair?.lead.modelID, "gpt-5.6-sol")
    assert.equal(status.pair?.sidekick.variant, "high")
  })

  it("reports what apply did", async () => {
    const { raw, calls } = fakeRaw()
    const fusion = fusionClient(raw)
    assert.deepEqual(await fusion.apply(), { applied: true })
    assert.deepEqual(calls, [{ method: "apply", input: {} }])
  })

  it("passes the sessionID through to the sidekicks call", async () => {
    const { raw, calls } = fakeRaw()
    const fusion = fusionClient(raw)
    const result = await fusion.sidekicks({ sessionID: "ses_lead" })
    assert.deepEqual(calls, [{ method: "sidekicks", input: { sessionID: "ses_lead" } }])
    assert.deepEqual(result.sessionIDs, ["ses_side"])
    assert.equal(result.running, true)
  })

  it("unwraps event data for the handler", () => {
    const { raw, emit } = fakeRaw()
    const fusion = fusionClient(raw)
    const seen: unknown[] = []
    fusion.events.on("pairChanged", (event) => {
      seen.push(event)
    })
    emit("pairChanged", { lead: { providerID: "p", modelID: "m" }, sidekick: { providerID: "p", modelID: "n" } })
    assert.deepEqual(seen, [
      { lead: { providerID: "p", modelID: "m" }, sidekick: { providerID: "p", modelID: "n" } },
    ])
  })

  it("keeps event types apart: handoffChanged carries the session ids and flag", () => {
    const { raw, emit } = fakeRaw()
    const fusion = fusionClient(raw)
    const running: Record<string, boolean> = {}
    fusion.events.on("handoffChanged", (event) => {
      running[event.leadSessionID] = event.running
    })
    emit("handoffChanged", { leadSessionID: "ses_lead", sidekickSessionID: "ses_side", running: true })
    assert.deepEqual(running, { ses_lead: true })
  })

  it("stops delivering once the returned disposer is called", () => {
    const { raw, emit } = fakeRaw()
    const fusion = fusionClient(raw)
    let calls = 0
    const off = fusion.events.on("pairChanged", () => {
      calls += 1
    })
    emit("pairChanged", { lead: { providerID: "p", modelID: "m" }, sidekick: { providerID: "p", modelID: "n" } })
    off()
    emit("pairChanged", { lead: { providerID: "p", modelID: "m" }, sidekick: { providerID: "p", modelID: "n" } })
    assert.equal(calls, 1)
  })
})
