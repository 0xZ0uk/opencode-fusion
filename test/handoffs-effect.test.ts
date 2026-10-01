import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Context, Effect, Exit, Fiber, Scope } from "effect"
import { makeHandoffs, type StepEnded, type Transcript } from "../src/handoffs.ts"
import type { EffectSidekickHost } from "../src/host.ts"
import type { SidekickSessionsApi } from "../src/sidekick-sessions.ts"

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const transcript = (messages: unknown[]): Transcript => messages as Transcript
const step = (files?: string[]): StepEnded => ({ files }) as unknown as StepEnded

function createHost() {
  const prompts: Array<{ sessionID: string; text: string; metadata: Record<string, string> }> = []
  const synthetics: Array<{ sessionID: string; text: string; resume?: boolean }> = []
  const interrupts: string[] = []
  const waits: string[] = []
  const abortedWaits: string[] = []
  const waiters = new Map<string, Array<() => void>>()
  let promptImpl: (() => Effect.Effect<{ id: string }, unknown>) | undefined
  let contextImpl: (sessionID: string) => Effect.Effect<Transcript, unknown> = () => Effect.succeed(transcript([]))
  let workingDiffImpl: () => Effect.Effect<readonly { file: string; additions: number; deletions: number }[], unknown> = () =>
    Effect.succeed([])
  let waitImpl:
    | ((sessionID: string) => Effect.Effect<void, unknown>)
    | undefined

  const host: EffectSidekickHost = {
    prompt: (input) =>
      promptImpl
        ? promptImpl()
        : Effect.sync(() => {
            prompts.push(input)
            return { id: "inbox-1" }
          }),
    wait: (sessionID) =>
      waitImpl
        ? waitImpl(sessionID)
        : Effect.callback<void>((resume, signal) => {
            waits.push(sessionID)
            const list = waiters.get(sessionID) ?? []
            list.push(() => resume(Effect.void))
            waiters.set(sessionID, list)
            const onAbort = () => abortedWaits.push(sessionID)
            signal.addEventListener("abort", onAbort, { once: true })
            return Effect.sync(() => signal.removeEventListener("abort", onAbort))
          }),
    context: (sessionID) => contextImpl(sessionID),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interrupts.push(sessionID)
        return { interrupted: true }
      }),
    synthetic: (input) => Effect.sync(() => synthetics.push(input)),
    workingDiff: () => workingDiffImpl(),
  }

  return {
    host,
    prompts,
    synthetics,
    interrupts,
    waits,
    abortedWaits,
    release: (sessionID?: string) => {
      for (const [id, list] of waiters) {
        if (sessionID !== undefined && id !== sessionID) continue
        for (const resolve of list) resolve()
        waiters.delete(id)
      }
    },
    setPrompt: (impl: () => Effect.Effect<{ id: string }, unknown>) => {
      promptImpl = impl
    },
    setContext: (impl: (sessionID: string) => Effect.Effect<Transcript, unknown>) => {
      contextImpl = impl
    },
    setWorkingDiff: (impl: () => Effect.Effect<readonly { file: string; additions: number; deletions: number }[], unknown>) => {
      workingDiffImpl = impl
    },
    setWait: (impl?: (sessionID: string) => Effect.Effect<void, unknown>) => {
      waitImpl = impl
    },
  }
}

function build(options: { blockTimeoutSeconds?: number } = {}) {
  const scope = Effect.runSync(Scope.make())
  const sessions: SidekickSessionsApi = {
    ensure: () => Effect.succeed("sk-1"),
    current: () => "sk-1",
    forget: () => Effect.void,
  }
  const h = createHost()
  const service = Effect.runSync(
    Effect.provideService(
      makeHandoffs({ host: h.host, sessions, blockTimeoutSeconds: options.blockTimeoutSeconds ?? 1800 }),
      Scope.Scope,
      scope,
    ),
  )
  return {
    ...h,
    service,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    delegate: (overrides: Partial<Parameters<typeof service.delegate>[0]> = {}) =>
      service.delegate({
        leadSessionID: "lead-1",
        message: "do the thing",
        block: true,
        reset: false,
        progress: () => Effect.void,
        ...overrides,
      }),
  }
}

const matchingTranscript = (t: ReturnType<typeof build>, text: string) => {
  t.setContext(() =>
    Effect.succeed(
      transcript([
        { type: "user", id: "u1", metadata: { fusionHandoff: t.prompts[0]?.metadata.fusionHandoff }, content: [] },
        { type: "assistant", id: "a1", content: [{ type: "text", text }] },
      ]),
    ),
  )
}

describe("delegate failures", () => {
  it("drops the handoff and step listener when wait rejects", async () => {
    const t = build()
    t.setWait(() => Effect.fail(new Error("wait blew up")))

    await assert.rejects(Effect.runPromise(t.delegate()), /wait blew up/)
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)

    t.setWait(undefined)
    const progress: Array<Record<string, unknown>> = []
    const next = Effect.runPromise(t.delegate({ progress: (u) => Effect.sync(() => progress.push(u)) }))
    await settle()
    t.service.onStep("sk-1", step(["a.ts"]))
    await settle()
    assert.deepEqual(
      progress.filter((u) => String(u.title).startsWith("sidekick · step")).map((u) => u.steps),
      [1],
    )
    t.release("sk-1")
    await next
    await t.close()
  })

  it("drops the handoff when context rejects after wait resolves", async () => {
    const t = build()
    const pending = Effect.runPromise(t.delegate())
    await settle()
    t.setContext(() => Effect.fail(new Error("context down")))
    t.release("sk-1")
    await assert.rejects(pending, /context down/)
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)
  })
})

describe("timeout", () => {
  it("aborts the losing wait signal without interrupting the remote, then posts once", async () => {
    const t = build({ blockTimeoutSeconds: 0 })
    matchingTranscript(t, "late report")

    const result = await Effect.runPromise(t.delegate())
    assert.match(result.content, /detached to the background/)
    assert.deepEqual(t.interrupts, [], "timeout must not interrupt the remote sidekick")
    assert.deepEqual(t.abortedWaits, ["sk-1"], "the losing wait's signal is aborted")

    t.release("sk-1")
    await settle()
    assert.equal(t.synthetics.length, 1)
    await t.close()
  })
})

describe("signal listener cleanup", () => {
  it("removes the abort listener after a successful foreground handoff", async () => {
    const t = build()
    matchingTranscript(t, "done")
    const controller = new AbortController()
    let removed = 0
    const origRemove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removed += 1
      return origRemove(...args)
    }) as AbortSignal["removeEventListener"]

    const pending = Effect.runPromise(t.delegate({ signal: controller.signal }))
    await settle()
    t.release("sk-1")
    const result = await pending
    assert.match(result.content, /^done\n/)
    assert.ok(removed > 0, "the abort listener was removed")
    controller.abort()
    await t.close()
  })
})

describe("interruption", () => {
  it("interrupts the remote session and cleans up on native interruption", async () => {
    const t = build()
    const fiber = Effect.runFork(t.delegate())
    await settle()
    await Effect.runPromise(Fiber.interrupt(fiber))

    assert.deepEqual(t.interrupts, ["sk-1"])
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)
    await t.close()
  })
})

describe("dispose", () => {
  it("returns while a signal-ignoring host.wait is pending and suppresses its later report", async () => {
    const t = build()
    matchingTranscript(t, "should never post")
    let manualRelease!: () => void
    t.setWait(() =>
      Effect.callback<void>((resume) => {
        manualRelease = () => resume(Effect.void)
        return Effect.sync(() => {})
      }),
    )

    const result = await Effect.runPromise(t.delegate({ block: false }))
    assert.match(result.content, /sidekick started in session sk-1/)

    await settle()
    await t.close()
    manualRelease()
    await settle()
    assert.equal(t.synthetics.length, 0)
  })
})

describe("early cleanup", () => {
  it("interrupts the remote and drops the record when interrupted during the first progress", async () => {
    const t = build()
    const fiber = Effect.runFork(t.delegate({ progress: () => Effect.never }))
    await settle()
    await Effect.runPromise(Fiber.interrupt(fiber))

    assert.deepEqual(t.interrupts, ["sk-1"])
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)
    await t.close()
  })

  it("drops the record and does not leak when the prompt rejects", async () => {
    const t = build()
    t.setPrompt(() => Effect.fail(new Error("prompt rejected")))
    await assert.rejects(Effect.runPromise(t.delegate()), /prompt rejected/)
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)
    await t.close()
  })

  it("interrupts the remote when interrupted while the prompt is in flight", async () => {
    const t = build()
    t.setPrompt(() => Effect.never)
    const fiber = Effect.runFork(t.delegate())
    await settle()
    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.deepEqual(t.interrupts, ["sk-1"])
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)
    await t.close()
  })

  it("suppresses the foreground report when cancel lands during the diff", async () => {
    const t = build()
    matchingTranscript(t, "should not post")
    let releaseDiff!: () => void
    t.setWorkingDiff(() => Effect.promise(() => new Promise<void>((resolve) => (releaseDiff = resolve)).then(() => [])))

    const pending = Effect.runPromise(t.delegate())
    await settle()
    t.release("sk-1")
    await settle()

    await Effect.runPromise(t.service.cancel("lead-1"))
    releaseDiff()
    const result = await pending
    assert.match(result.content, /^sidekick: cancelled/)
    assert.equal(t.synthetics.length, 0)
    await t.close()
  })

  it("completed background monitors accumulate nothing in the scope", async () => {
    const t = build()
    matchingTranscript(t, "bg report")
    for (const _ of [0, 1, 2]) {
      await Effect.runPromise(t.delegate({ block: false }))
      t.release("sk-1")
      await settle()
    }
    assert.equal(t.synthetics.length, 3)
    assert.match(t.service.status("lead-1"), /^no handoff in flight/)
    await t.close()
  })
})

describe("progress context", () => {
  it("fan-out progress sees the delegate call's context", async () => {
    const TestRef = Context.Reference<string>("fusion-test/progress-ref", { defaultValue: () => "default" })
    const t = build()
    const seen: string[] = []
    const pending = Effect.runPromise(
      Effect.provideService(
        t.delegate({
          progress: () =>
            Effect.gen(function* () {
              seen.push(yield* TestRef)
            }),
        }),
        TestRef,
        "custom",
      ),
    )
    await settle()
    t.service.onStep("sk-1", step(["a.ts"]))
    await settle()
    t.release("sk-1")
    await pending
    assert.ok(seen.length >= 2)
    assert.deepEqual([...new Set(seen)], ["custom"])
    await t.close()
  })
})

describe("cancel", () => {
  it("suppresses the report when cancel lands while the diff is in flight", async () => {
    const t = build()
    matchingTranscript(t, "should not post")
    let releaseDiff!: () => void
    t.setWorkingDiff(() => Effect.promise(() => new Promise<void>((resolve) => (releaseDiff = resolve)).then(() => [])))

    await Effect.runPromise(t.delegate({ block: false }))
    t.release("sk-1")
    await settle()

    await Effect.runPromise(t.service.cancel("lead-1"))
    releaseDiff()
    await settle()
    assert.equal(t.synthetics.length, 0)
    await t.close()
  })
})
