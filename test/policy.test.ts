import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_SHELL_ALLOWLIST, leadPolicy, sidekickRules } from "../src/policy.ts"

const SIDEKICK = "fusion-sidekick"
const NUDGE = (action: string) =>
  `Fusion: the lead may not use "${action}". Delegate this to the sidekick with the \`sidekick\` tool.`

const EDITS = leadPolicy("edits", ["git status*"], SIDEKICK)
const FULL = leadPolicy("full", ["git status*"], SIDEKICK)

describe("leadPolicy rules", () => {
  it("off adds no rules and enforces nothing", () => {
    const policy = leadPolicy("off", ["git status*"], SIDEKICK)
    assert.deepEqual(policy.rules, [])
    assert.equal(policy.deny("edit", ["src/a.ts"]), undefined)
    assert.equal(policy.deny("shell", ["rm -rf x"]), undefined)
  })

  it("edits denies edits, denies all subagents except the sidekick, and adds no grep/shell rules", () => {
    assert.deepEqual(EDITS.rules, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: SIDEKICK, effect: "allow" },
    ])
  })

  it("full adds grep/glob/shell denies plus the allowlist, and no sidekick subagent allow", () => {
    assert.deepEqual(FULL.rules, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "grep", resource: "*", effect: "deny" },
      { action: "glob", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git status*", effect: "allow" },
    ])
  })

  it("appends each allowlist entry in order after the shell deny", () => {
    const policy = leadPolicy("full", ["a*", "b*"], SIDEKICK)
    assert.deepEqual(policy.rules.slice(-2), [
      { action: "shell", resource: "a*", effect: "allow" },
      { action: "shell", resource: "b*", effect: "allow" },
    ])
  })
})

describe("deny", () => {
  it("last match wins: the allowlist overrides the shell deny", () => {
    assert.equal(FULL.deny("shell", ["git status -s"]), undefined)
    assert.equal(FULL.deny("shell", ["rm -rf x"]), NUDGE("shell"))
  })

  it("returns the delegation nudge naming the action", () => {
    assert.equal(FULL.deny("edit", ["src/a.ts"]), NUDGE("edit"))
  })

  it("denies when any listed resource matches, and checks an empty list as \"\"", () => {
    assert.equal(FULL.deny("edit", []), NUDGE("edit"))
    assert.equal(FULL.deny("edit", ["a.ts", "b.ts"]), NUDGE("edit"))
    assert.equal(FULL.deny("read", ["a.ts"]), undefined)
  })

  it("subagent to the sidekick is denied in full and allowed in edits", () => {
    assert.equal(FULL.deny("subagent", [SIDEKICK]), NUDGE("subagent"))
    assert.equal(EDITS.deny("subagent", [SIDEKICK]), undefined)
    assert.equal(EDITS.deny("subagent", ["other"]), NUDGE("subagent"))
  })

  it("* is the only wildcard: . and ? stay literal", () => {
    const policy = leadPolicy("full", ["git.status", "a?b"], SIDEKICK)
    assert.equal(policy.deny("shell", ["gitXstatus"]), NUDGE("shell"))
    assert.equal(policy.deny("shell", ["git.status"]), undefined)
    assert.equal(policy.deny("shell", ["aZb"]), NUDGE("shell"))
    assert.equal(policy.deny("shell", ["a?b"]), undefined)
  })
})

describe("prompt matches the rules", () => {
  it("claims the lead cannot edit exactly when edit is denied", () => {
    for (const level of ["full", "edits", "off"] as const) {
      const policy = leadPolicy(level, DEFAULT_SHELL_ALLOWLIST, SIDEKICK)
      assert.equal(/cannot edit files/.test(policy.system), policy.deny("edit", ["src/a.ts"]) !== undefined, level)
    }
  })

  it("lists every allowed shell command, and the rules allow exactly those", () => {
    const allowlist = [...DEFAULT_SHELL_ALLOWLIST, "pnpm test*"]
    const policy = leadPolicy("full", allowlist, SIDEKICK)
    for (const pattern of allowlist) {
      assert.ok(policy.system.includes(`\`${pattern}\``), `prompt lists ${pattern}`)
      assert.equal(policy.deny("shell", [pattern]), undefined, `rules allow ${pattern}`)
    }
    assert.equal(policy.deny("shell", ["curl http://example.com"]), NUDGE("shell"))
  })

  it("full names the denials the rules enforce", () => {
    assert.match(FULL.system, /cannot use grep or glob/)
    assert.match(FULL.system, /built-in subagent tool is disabled/)
    assert.equal(FULL.deny("grep", ["TODO"]), NUDGE("grep"))
    assert.equal(FULL.deny("glob", ["**/*.ts"]), NUDGE("glob"))
  })

  it("edits says changes go through the sidekick while reads stay open", () => {
    assert.match(EDITS.system, /cannot edit files/)
    assert.match(EDITS.system, /read, search and run shell commands/)
    assert.equal(EDITS.deny("grep", ["TODO"]), undefined)
    assert.equal(EDITS.deny("shell", ["ls"]), undefined)
  })

  it("off says nothing is enforced", () => {
    const policy = leadPolicy("off", DEFAULT_SHELL_ALLOWLIST, SIDEKICK)
    assert.match(policy.system, /Nothing is enforced/)
  })
})

describe("sidekickRules", () => {
  it("auto-approve allows edits and shell, and always denies subagents", () => {
    assert.deepEqual(sidekickRules(true), [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
  })

  it("without auto-approve only the subagent deny is added", () => {
    assert.deepEqual(sidekickRules(false), [{ action: "subagent", resource: "*", effect: "deny" }])
  })
})
