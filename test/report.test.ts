import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { handoffReport } from "../src/handoffs.ts"

type Transcript = Parameters<typeof handoffReport>[0]

const user = (id: string, metadata?: Record<string, string>) => ({ type: "user", id, metadata, content: [] })
const assistant = (id: string, text: string, files?: string[]) => ({
  type: "assistant",
  id,
  content: text ? [{ type: "text", text }] : [],
  ...(files ? { snapshot: { files } } : {}),
})
const transcript = (messages: unknown[]): Transcript => messages as Transcript

describe("handoffReport", () => {
  it("matches the user message carrying metadata.fusionHandoff", () => {
    const report = handoffReport(
      transcript([user("u1", { fusionHandoff: "h1" }), assistant("a1", "the report")]),
      "h1",
      undefined,
    )
    assert.equal(report.matched, true)
    assert.equal(report.text, "the report")
  })

  it("matches by inbox id when the marker is absent", () => {
    const report = handoffReport(transcript([user("inbox-1"), assistant("a1", "via inbox")]), "other", "inbox-1")
    assert.equal(report.matched, true)
    assert.equal(report.text, "via inbox")
  })

  it("ends the slice at the next user message", () => {
    const report = handoffReport(
      transcript([
        user("u1", { fusionHandoff: "h1" }),
        assistant("a1", "first report"),
        user("u2", { fusionHandoff: "h2" }),
        assistant("a2", "second report"),
      ]),
      "h1",
      undefined,
    )
    assert.equal(report.matched, true)
    assert.equal(report.text, "first report")
  })

  it("picks the last non-empty assistant text in the slice", () => {
    const report = handoffReport(
      transcript([user("u1", { fusionHandoff: "h1" }), assistant("a1", ""), assistant("a2", "final answer")]),
      "h1",
      undefined,
    )
    assert.equal(report.text, "final answer")
  })

  it("de-duplicates snapshot files in order across the slice", () => {
    const report = handoffReport(
      transcript([
        user("u1", { fusionHandoff: "h1" }),
        assistant("a1", "part", ["a.ts", "b.ts"]),
        assistant("a2", "done", ["b.ts", "c.ts"]),
      ]),
      "h1",
      undefined,
    )
    assert.deepEqual(report.files, ["a.ts", "b.ts", "c.ts"])
  })

  it("falls back to the last assistant text overall when the marker is missing", () => {
    const report = handoffReport(
      transcript([user("u1"), assistant("a1", "older"), assistant("a2", "latest", ["x.ts"])]),
      "not-here",
      "also-not-here",
    )
    assert.equal(report.matched, false)
    assert.equal(report.text, "latest")
    assert.deepEqual(report.files, [])
  })
})
