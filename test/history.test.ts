import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeHistory } from "../src/server.ts"

describe("normalizeHistory", () => {
  it("keeps string lists and drops non-string and non-array entries", () => {
    assert.deepEqual(
      normalizeHistory({
        a: ["s1", "s2"],
        b: "not-an-array",
        c: [1, "s3", null],
        d: [],
        e: 42,
      }),
      { a: ["s1", "s2"], c: ["s3"] },
    )
  })

  it("returns an empty record for non-objects", () => {
    assert.deepEqual(normalizeHistory(undefined), {})
    assert.deepEqual(normalizeHistory("junk"), {})
    assert.deepEqual(normalizeHistory(null), {})
  })
})
