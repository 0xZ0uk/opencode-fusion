import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  createHandoffs,
  type FileStat,
  type HandoffChanged,
  type SidekickHost,
  type SidekickSessions,
  type StepEnded,
  type Transcript,
} from "../src/handoffs.ts"

/** Let the pending microtasks (and the async IIFEs they start) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const user = (id: string, metadata?: Record<string, string>) => ({ type: "user", id, metadata, content: [] })
const assistant = (id: string, text: string, files?: string[]) => ({
  type: "assistant",
  id,
  content: text ? [{ type: "text", text }] : [],
  ...(files ? { snapshot: { files } } : {}),
})
const transcript = (messages: unknown[]): Transcript => messages as Transcript

const step = (files?: string[]): StepEnded => ({ files }) as unknown as StepEnded

function createHost() {
  const prompts: Array<{ sessionID: string; text: string; metadata: Record<string, string> }> = []
  const synthetics: Array<{ sessionID: string; text: string; resume?: boolean }> = []
  const interrupts: string[] = []
  const waits: string[] = []
  const waiters = new Map<string, Array<() => void>>()
  let inboxCounter = 0
  let contextImpl: (sessionID: string) => Promise<Transcript> = async () => transcript([])
  let workingDiffImpl: () => Promise<readonly FileStat[]> = async () => []

  const host: SidekickHost = {
    async prompt(input) {
      prompts.push(input)
      return { id: `inbox-${++inboxCounter}` }
    },
    wait(sessionID) {
      waits.push(sessionID)
      return new Promise<void>((resolve) => {
        const list = waiters.get(sessionID) ?? []
        list.push(resolve)
        waiters.set(sessionID, list)
      })
    },
    context: (sessionID) => contextImpl(sessionID),
    async interrupt(sessionID) {
      interrupts.push(sessionID)
      return { interrupted: true }
    },
    async synthetic(input) {
      synthetics.push(input)
    },
    workingDiff: () => workingDiffImpl(),
  }

  const release = (sessionID?: string) => {
    for (const [id, list] of waiters) {
      if (sessionID !== undefined && id !== sessionID) continue
      for (const resolve of list) resolve()
      waiters.delete(id)
    }
  }

  return {
    host,
    prompts,
    synthetics,
    interrupts,
    waits,
    release,
    setContext: (impl: (sessionID: string) => Promise<Transcript>) => {
      contextImpl = impl
    },
    setWorkingDiff: (impl: () => Promise<readonly FileStat[]>) => {
      workingDiffImpl = impl
    },
  }
}

function createSessions() {
  const map = new Map<string, string>()
  const forgotten: string[] = []
  let counter = 0
  const sessions: SidekickSessions = {
    async ensure(leadSessionID) {
      const existing = map.get(leadSessionID)
      if (existing) return existing
      const id = `sk-${++counter}`
      map.set(leadSessionID, id)
      return id
    },
    current: (leadSessionID) => map.get(leadSessionID),
    async forget(leadSessionID) {
      forgotten.push(leadSessionID)
      map.delete(leadSessionID)
    },
  }
  return { sessions, map, forgotten }
}

function setup(options: { blockTimeoutSeconds?: number } = {}) {
  const host = createHost()
  const sessions = createSessions()
  const events: HandoffChanged[] = []
  const handoffs = createHandoffs({
    host: host.host,
    sessions: sessions.sessions,
    blockTimeoutSeconds: options.blockTimeoutSeconds ?? 1800,
  })
  handoffs.setEmitter((event) => events.push(event))
  return { ...host, ...sessions, handoffs, events }
}

/** Delegate helper with sensible defaults; returns the delegate promise. */
const delegate = (
  t: ReturnType<typeof setup>,
  overrides: Partial<{
    leadSessionID: string
    message: string
    block: boolean
    reset: boolean
    signal: AbortSignal
    progress: (update: Record<string, unknown>) => void | Promise<void>
  }> = {},
) =>
  t.handoffs.delegate({
    leadSessionID: "lead-1",
    message: "do the thing",
    block: true,
    reset: false,
    signal: new AbortController().signal,
    progress: () => {},
    ...overrides,
  })

/** Context whose transcript carries the marker the fake host recorded at prompt time. */
const matchingTranscript = (t: ReturnType<typeof setup>, text: string, files?: string[]) => {
  t.setContext(async () =>
    transcript([
      { type: "user", id: "u1", metadata: { fusionHandoff: t.prompts[0]?.metadata.fusionHandoff }, content: [] },
      assistant("a1", text, files),
    ]),
  )
}

describe("delegate", () => {
  it("settles a foreground handoff with the formatted report", async () => {
    const t = setup()
    matchingTranscript(t, "did the thing", ["a.ts", "b.ts"])
    t.setWorkingDiff(async () => [
      { file: "a.ts", additions: 3, deletions: 1 },
      { file: "b.ts", additions: 0, deletions: 1 },
    ])
    const progress: Record<string, unknown>[] = []

    const pending = delegate(t, {
      progress: (update) => {
        progress.push(update)
      },
    })
    await settle()
    t.release("sk-1")
    const result = await pending

    assert.match(result.content, /^did the thing\n/)
    assert.match(result.content, /a\.ts \(\+3 −1 working tree\)/)
    assert.match(result.content, /b\.ts \(\+0 −1 working tree\)/)
    assert.match(result.content, /sidekick session: sk-1$/)
    assert.equal(result.metadata?.sessionID, "sk-1")
    assert.equal(result.metadata?.handoffID, t.prompts[0]?.metadata.fusionHandoff)
    assert.deepEqual(result.metadata?.files, ["a.ts", "b.ts"])
    assert.equal(t.prompts[0]?.metadata.fusionLeadSession, "lead-1")
    assert.equal(t.prompts[0]?.sessionID, "sk-1")
    assert.equal(t.prompts[0]?.text, "do the thing")
    assert.equal(progress[0]?.title, "sidekick running")
    assert.deepEqual(t.events, [
      { leadSessionID: "lead-1", sidekickSessionID: "sk-1", running: true },
      { leadSessionID: "lead-1", sidekickSessionID: "sk-1", running: false },
    ])
    assert.equal(t.handoffs.running("lead-1"), false)
  })

  it("forgets the sidekick session before ensure when reset is set", async () => {
    const t = setup()
    matchingTranscript(t, "fresh")
    const pending = delegate(t, { reset: true })
    await settle()
    t.release()
    await pending
    assert.deepEqual(t.forgotten, ["lead-1"])
  })

  it("returns immediately for block false and posts the report via synthetic", async () => {
    const t = setup()
    matchingTranscript(t, "background report")

    const result = await delegate(t, { block: false })

    assert.match(
      result.content,
      /^sidekick started in session sk-1 \(handoff [0-9a-f]{8}\); its report will arrive as a follow-up message\.$/,
    )
    assert.equal(t.synthetics.length, 0)
    t.release("sk-1")
    await settle()
    assert.equal(t.synthetics.length, 1)
    assert.equal(t.synthetics[0]?.sessionID, "lead-1")
    assert.equal(t.synthetics[0]?.resume, true)
    assert.match(t.synthetics[0]?.text ?? "", /^<sidekick_report session="sk-1" handoff="[0-9a-f-]+">\n/)
    assert.match(t.synthetics[0]?.text ?? "", /background report/)
    assert.match(t.synthetics[0]?.text ?? "", /\n<\/sidekick_report>$/)
    assert.equal(t.events.at(-1)?.running, false)
  })

  it("detaches to the background on timeout and posts the report later", async () => {
    const t = setup({ blockTimeoutSeconds: 0 })
    matchingTranscript(t, "late report")

    const result = await delegate(t)

    assert.equal(
      result.content,
      'sidekick: still running after 0s; detached to the background — its report will arrive as a follow-up message. Use action "status"/"cancel" to manage it.',
    )
    assert.equal(result.metadata?.sessionID, "sk-1")
    assert.equal(t.synthetics.length, 0)
    t.release("sk-1")
    await settle()
    assert.equal(t.synthetics.length, 1)
    assert.match(t.synthetics[0]?.text ?? "", /late report/)
  })

  it("interrupts and cancels when the lead's turn is aborted", async () => {
    const t = setup()
    const controller = new AbortController()
    controller.abort()

    const result = await delegate(t, { signal: controller.signal })

    assert.equal(result.content, "sidekick: cancelled — the lead's turn was aborted; the sidekick was interrupted.")
    assert.deepEqual(t.interrupts, ["sk-1"])
    assert.equal(t.synthetics.length, 0)
    assert.equal(t.handoffs.running("lead-1"), false)
    assert.deepEqual(t.events.at(-1), { leadSessionID: "lead-1", sidekickSessionID: "sk-1", running: false })
  })
})

describe("cancel", () => {
  it("lists the in-flight handoff ids and suppresses the later report", async () => {
    const t = setup()
    matchingTranscript(t, "should not post")

    const result = await delegate(t, { block: false })
    const handoffID = String(result.metadata?.handoffID)
    const cancelled = await t.handoffs.cancel("lead-1")

    assert.equal(cancelled, `sidekick: cancelled ${handoffID.slice(0, 8)} (interrupted=true)`)
    assert.deepEqual(t.interrupts, ["sk-1"])
    t.release("sk-1")
    await settle()
    assert.equal(t.synthetics.length, 0)
  })

  it("says nothing was in flight and reports no session", async () => {
    const t = setup()
    assert.equal(await t.handoffs.cancel("lead-1"), "sidekick: no sidekick session")
    assert.equal(await t.handoffs.cancel("lead-2"), "sidekick: no sidekick session")
  })
})

describe("status", () => {
  it("lists foreground and background handoffs, then the none fallback", async () => {
    const t = setup()
    assert.equal(
      t.handoffs.status("lead-1"),
      "no handoff in flight\nsidekick session: none\n(only handoffs started by this process are listed)",
    )

    await delegate(t, { block: false })
    const foreground = delegate(t)
    await settle()

    const lines = t.handoffs.status("lead-1").split("\n")
    assert.equal(lines[0], "handoffs in flight:")
    assert.match(lines[1] ?? "", /^[0-9a-f]{8} · background · \d+s$/)
    assert.match(lines[2] ?? "", /^[0-9a-f]{8} · foreground · \d+s$/)
    assert.equal(lines[3], "sidekick session: sk-1")
    assert.equal(lines[4], "(only handoffs started by this process are listed)")

    t.release("sk-1")
    await foreground
    await settle()
    assert.equal(
      t.handoffs.status("lead-1"),
      "no handoff in flight\nsidekick session: sk-1\n(only handoffs started by this process are listed)",
    )
  })
})

describe("step fan-out", () => {
  it("reports de-duplicated step files and removes the listener at the end", async () => {
    const t = setup()
    matchingTranscript(t, "done", ["a.ts"])
    const progress: Record<string, unknown>[] = []

    const pending = delegate(t, {
      progress: (update) => {
        progress.push(update)
      },
    })
    await settle()

    t.handoffs.onStep("sk-1", step(["a.ts"]))
    t.handoffs.onStep("sk-1", step(["a.ts", "b.ts"]))
    t.handoffs.onStep("sk-1", step())
    t.handoffs.onStep("other", step(["x.ts"]))

    const stepUpdates = progress.filter((update) => String(update.title).startsWith("sidekick · step"))
    assert.deepEqual(
      stepUpdates.map((update) => update.title),
      ["sidekick · step 1", "sidekick · step 2", "sidekick · step 3"],
    )
    assert.deepEqual(stepUpdates[0]?.files, ["a.ts"])
    assert.deepEqual(stepUpdates[1]?.files, ["a.ts", "b.ts"])
    assert.deepEqual(stepUpdates[2]?.files, ["a.ts", "b.ts"])

    t.release("sk-1")
    await pending

    t.handoffs.onStep("sk-1", step(["c.ts"]))
    assert.equal(
      progress.filter((update) => String(update.title).startsWith("sidekick · step")).length,
      3,
    )
  })
})

describe("formatReport fallbacks", () => {
  it("says none recorded when no files changed", async () => {
    const t = setup()
    matchingTranscript(t, "nothing to change")
    const pending = delegate(t)
    await settle()
    t.release("sk-1")
    const result = await pending
    assert.match(result.content, /nothing to change/)
    assert.match(result.content, /Changed files: none recorded/)
    assert.doesNotMatch(result.content, /matched by recency/)
  })

  it("falls back to bare paths when the working diff throws", async () => {
    const t = setup()
    matchingTranscript(t, "changed one file", ["a.ts"])
    t.setWorkingDiff(async () => {
      throw new Error("no vcs here")
    })
    const pending = delegate(t)
    await settle()
    t.release("sk-1")
    const result = await pending
    assert.match(result.content, /Changed files:\na\.ts$/m)
    assert.doesNotMatch(result.content, /a\.ts \(\+/)
  })

  it("adds the recency warning when the handoff marker is missing", async () => {
    const t = setup()
    t.setContext(async () => transcript([assistant("a1", "orphan report")]))
    const pending = delegate(t)
    await settle()
    t.release("sk-1")
    const result = await pending
    assert.match(result.content, /orphan report/)
    assert.match(result.content, /Changed files: none recorded/)
    assert.match(result.content, /\(report matched by recency, not by handoff — may belong to another handoff\)/)
  })

  it("refuses the recency warning only when matched", async () => {
    const t = setup()
    matchingTranscript(t, "matched report")
    const pending = delegate(t)
    await settle()
    t.release("sk-1")
    const result = await pending
    assert.match(result.content, /matched report/)
    assert.doesNotMatch(result.content, /matched by recency/)
  })
})
