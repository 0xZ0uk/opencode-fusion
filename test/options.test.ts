import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeOptions } from "../src/options.ts"

describe("normalizeOptions", () => {
  it("fills every default for missing or non-object input", () => {
    for (const input of [undefined, null, 42, "nope", []]) {
      assert.deepEqual(normalizeOptions(input), {
        enforce: "full",
        leadAgent: "fusion",
        sidekickAgent: "sidekick",
        allowShell: [],
        sidekickAutoApprove: true,
        blockTimeoutSeconds: 1800,
      })
    }
  })

  it("accepts a fully valid custom config", () => {
    assert.deepEqual(
      normalizeOptions({
        enforce: "edits",
        leadAgent: "my-lead",
        sidekickAgent: "my-sidekick",
        allowShell: ["git *"],
        sidekickAutoApprove: false,
        blockTimeoutSeconds: 60,
      }),
      {
        enforce: "edits",
        leadAgent: "my-lead",
        sidekickAgent: "my-sidekick",
        allowShell: ["git *"],
        sidekickAutoApprove: false,
        blockTimeoutSeconds: 60,
      },
    )
  })

  it("falls back per field without discarding valid neighbours", () => {
    const out = normalizeOptions({
      enforce: "everything",
      leadAgent: "",
      sidekickAgent: "sk",
      allowShell: "git *",
      sidekickAutoApprove: "yes",
      blockTimeoutSeconds: "30",
    })
    assert.equal(out.enforce, "full")
    assert.equal(out.leadAgent, "fusion")
    assert.equal(out.sidekickAgent, "sk")
    assert.deepEqual(out.allowShell, [])
    assert.equal(out.sidekickAutoApprove, true)
    assert.equal(out.blockTimeoutSeconds, 1800)
  })

  it("keeps a zero timeout and rejects negative or non-finite ones", () => {
    assert.equal(normalizeOptions({ blockTimeoutSeconds: 0 }).blockTimeoutSeconds, 0)
    assert.equal(normalizeOptions({ blockTimeoutSeconds: -5 }).blockTimeoutSeconds, 1800)
    assert.equal(normalizeOptions({ blockTimeoutSeconds: Number.NaN }).blockTimeoutSeconds, 1800)
    assert.equal(normalizeOptions({ blockTimeoutSeconds: Number.POSITIVE_INFINITY }).blockTimeoutSeconds, 1800)
  })
})
