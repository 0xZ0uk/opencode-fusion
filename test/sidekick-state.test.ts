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
      { id: "sk-1", status: "idle" },
      { id: "sk-2", metadata: { fusionLeadSession: "lead-1" }, status: "idle" },
      { id: "sk-3", metadata: { fusionLeadSession: "lead-1" }, time: {}, status: "idle" },
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

  /**
   * The running flag is the whole point of this module, and it is the one thing
   * that can fail silently: the host's SessionInfo carries no status field, so a
   * call site that skipped the data.session.status() merge would hand us a list
   * where every status is undefined and this answer would be false forever.
   * This test fails the moment the comparison stops recognising "running".
   */
  it("flips on for exactly the host's \"running\" status, in both positions", () => {
    for (const [first, second] of [
      ["running", "idle"],
      ["idle", "running"],
    ] as const) {
      const sessions = [sidekick("sk-1", "lead-1", { status: first }), sidekick("sk-2", "lead-1", { status: second })]
      assert.equal(sidekickRunning(sessions, "lead-1"), true, `${first}/${second}`)
    }
    // And the same list with every status idle reads false — so the two cases
    // above are proving the flag, not a constant.
    const idle = [sidekick("sk-1", "lead-1"), sidekick("sk-2", "lead-1")]
    assert.equal(sidekickRunning(idle, "lead-1"), false)
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

  it("treats an unrecognised status as not running", () => {
    const sessions: SidekickSession[] = [
      sidekick("sk-1", "lead-1", { status: "busy" }),
      sidekick("sk-2", "lead-1", { status: "" }),
    ]
    assert.equal(sidekickRunning(sessions, "lead-1"), false)
  })

  it("is false for a lead with no sidekick session", () => {
    assert.equal(sidekickRunning(SESSIONS, "lead-3"), false)
  })
})
