import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { sidekickRunning, sidekickSessions, type SidekickSession } from "../src/sidekick-state.ts"

const sidekick = (id: string, leadSessionID: string, extra: Partial<SidekickSession> = {}): SidekickSession => ({
  id,
  metadata: { fusionLeadSession: leadSessionID },
  time: {},
  status: "idle",
  ...extra,
})

const lead = (id: string): SidekickSession => ({ id, metadata: {}, time: {}, status: "idle" })

const SESSIONS: SidekickSession[] = [
  lead("lead-1"),
  sidekick("sk-1", "lead-1"),
  sidekick("sk-2", "lead-2"),
  sidekick("sk-3", "lead-1"),
]

describe("sidekickSessions", () => {
  it("returns the lead's own sidekick sessions, in host order", () => {
    assert.deepEqual(sidekickSessions(SESSIONS, "lead-1"), ["sk-1", "sk-3"])
    assert.deepEqual(sidekickSessions(SESSIONS, "lead-2"), ["sk-2"])
  })

  it("returns nothing for a lead with no sidekick session", () => {
    assert.deepEqual(sidekickSessions(SESSIONS, "lead-3"), [])
    assert.deepEqual(sidekickSessions([], "lead-1"), [])
  })

  it("drops archived sessions — the plugin will not reuse them", () => {
    const sessions = [sidekick("sk-1", "lead-1", { time: { archived: 1740000000000 } }), sidekick("sk-2", "lead-1")]
    assert.deepEqual(sidekickSessions(sessions, "lead-1"), ["sk-2"])
  })

  it("ignores sessions that are not marked as a sidekick's", () => {
    const sessions = [lead("lead-1"), sidekick("sk-1", "lead-1"), { ...sidekick("sk-2", "lead-1"), metadata: {} }]
    assert.deepEqual(sidekickSessions(sessions, "lead-1"), ["sk-1"])
  })

  it("ignores a session with no metadata or no time block", () => {
    const sessions: SidekickSession[] = [
      { id: "sk-1" },
      { id: "sk-2", metadata: { fusionLeadSession: "lead-1" } },
      { id: "sk-3", metadata: { fusionLeadSession: "lead-1" }, time: { created: 1, updated: 2 } } as never,
    ]
    assert.deepEqual(sidekickSessions(sessions, "lead-1"), ["sk-2", "sk-3"])
  })

  it("does not match a lead id that is a prefix of another", () => {
    const sessions = [sidekick("sk-1", "lead-1"), sidekick("sk-2", "lead-10")]
    assert.deepEqual(sidekickSessions(sessions, "lead-1"), ["sk-1"])
  })
})

describe("sidekickRunning", () => {
  it("is true when any of the lead's live sidekicks is running", () => {
    const sessions = [sidekick("sk-1", "lead-1"), sidekick("sk-2", "lead-1", { status: "running" })]
    assert.equal(sidekickRunning(sessions, "lead-1"), true)
  })

  it("is false when the lead's sidekicks are all idle", () => {
    assert.equal(sidekickRunning(SESSIONS, "lead-1"), false)
  })

  it("ignores another lead's running sidekick", () => {
    const sessions = [sidekick("sk-1", "lead-1"), sidekick("sk-2", "lead-2", { status: "running" })]
    assert.equal(sidekickRunning(sessions, "lead-1"), false)
  })

  it("ignores an archived session even when it still reports running", () => {
    const sessions = [sidekick("sk-1", "lead-1", { time: { archived: 1740000000000 }, status: "running" })]
    assert.equal(sidekickRunning(sessions, "lead-1"), false)
  })

  it("treats a missing or unknown status as not running", () => {
    const sessions: SidekickSession[] = [
      { id: "sk-1", metadata: { fusionLeadSession: "lead-1" } },
      sidekick("sk-2", "lead-1", { status: "busy" }),
    ]
    assert.equal(sidekickRunning(sessions, "lead-1"), false)
  })

  it("is false for a lead with no sidekick session", () => {
    assert.equal(sidekickRunning(SESSIONS, "lead-3"), false)
  })
})
