import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decide, leadPermissions } from "../src/server.ts"

const EDITS = leadPermissions("edits", ["git status*"], "fusion-sidekick")
const FULL = leadPermissions("full", ["git status*"], "fusion-sidekick")

describe("leadPermissions", () => {
  it("off returns no rules", () => {
    assert.deepEqual(leadPermissions("off", ["git status*"], "fusion-sidekick"), [])
  })

  it("edits denies edits, denies all subagents except the sidekick, and adds no grep/shell rules", () => {
    assert.deepEqual(EDITS, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "fusion-sidekick", effect: "allow" },
    ])
  })

  it("full adds grep/glob/shell denies plus the allowlist, and no sidekick subagent allow", () => {
    assert.equal(FULL.some((rule) => rule.action === "subagent" && rule.effect === "allow"), false)
    for (const action of ["grep", "glob", "shell"]) {
      assert.deepEqual(
        FULL.find((rule) => rule.action === action && rule.resource === "*"),
        { action, resource: "*", effect: "deny" },
      )
    }
    assert.deepEqual(
      FULL.find((rule) => rule.action === "shell" && rule.effect === "allow"),
      { action: "shell", resource: "git status*", effect: "allow" },
    )
  })
})

describe("decide", () => {
  it("last match wins: the allowlist overrides the shell deny", () => {
    assert.equal(decide(FULL, "shell", "git status -s"), "allow")
    assert.equal(decide(FULL, "shell", "rm -rf x"), "deny")
  })

  it("subagent to the sidekick is denied in full and allowed in edits", () => {
    assert.equal(decide(FULL, "subagent", "fusion-sidekick"), "deny")
    assert.equal(decide(EDITS, "subagent", "fusion-sidekick"), "allow")
  })

  it("* is the only wildcard: . and ? stay literal", () => {
    const rules = [
      { action: "shell", resource: "git.status", effect: "deny" as const },
      { action: "shell", resource: "a?b", effect: "deny" as const },
    ]
    assert.equal(decide(rules, "shell", "gitXstatus"), undefined)
    assert.equal(decide(rules, "shell", "git.status"), "deny")
    assert.equal(decide(rules, "shell", "aZb"), undefined)
    assert.equal(decide(rules, "shell", "a?b"), "deny")
  })
})
