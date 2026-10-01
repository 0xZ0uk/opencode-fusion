/**
 * Lead permission policy.
 *
 * One enforcement level decides three things that have to agree: the rules the
 * lead agent carries, what its system prompt says it can do, and the call-time
 * backstop that refuses denied actions. They are generated together here so
 * prompt and rules cannot drift — an earlier split once told the lead to edit
 * files while edits were denied.
 *
 * JSX-free and no runtime `@opencode/*` imports: tests drive this module
 * directly, and `server.ts` only wires the result into the agent transform and
 * the permission hook.
 */

/**
 * How hard the delegation policy is enforced.
 * - "full": the lead cannot write files and cannot sweep the repo (edit/grep/glob denied),
 *   its shell is deny-by-default with a small allowlist, and it may only delegate to its sidekick.
 * - "edits": the lead cannot write files; everything else is untouched.
 * - "off": prompts only.
 */
export type Enforcement = "full" | "edits" | "off"

export type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** Commands the lead keeps: cheap verification and inspection, nothing that writes. */
export const DEFAULT_SHELL_ALLOWLIST = ["git status*", "git diff --stat*", "git diff HEAD --stat*", "git log --oneline*"]

/**
 * The lead's rules, prompt and call-time check, derived from one enforcement
 * level. `server.ts` appends `rules` to the agent's permissions, sets `system`
 * on the same transform, and routes hook events through `deny`.
 */
export type LeadPolicy = {
  /** Rules appended to the lead agent's existing permissions. */
  rules: readonly Rule[]
  /** System prompt describing exactly what `rules` enforce. */
  system: string
  /**
   * The refusal message when `action` is denied for any of `resources`, or
   * undefined when the policy lets the action through. An empty resource list
   * is checked as `[""]`, which every `*` rule matches; last matching rule wins.
   */
  deny(action: string, resources: readonly string[]): string | undefined
}

/**
 * Build the lead policy for one enforcement level. `shellAllowlist` is the
 * effective list — defaults plus user additions — so the prompt and the shell
 * rules always list the same commands.
 */
export function leadPolicy(
  enforcement: Enforcement,
  shellAllowlist: readonly string[],
  sidekickAgent: string,
): LeadPolicy {
  const rules = leadRules(enforcement, shellAllowlist, sidekickAgent)
  return {
    rules,
    system: leadSystem(enforcement, shellAllowlist),
    deny(action, resources) {
      const checked = resources.length > 0 ? resources : [""]
      if (!checked.some((resource) => decide(rules, action, resource) === "deny")) return undefined
      return delegationNudge(action)
    },
  }
}

/**
 * Rules applied to the sidekick agent. Auto-approve keeps handoffs from stalling
 * on a prompt the lead cannot see; the subagent deny is unconditional — the
 * sidekick never delegates.
 */
export function sidekickRules(autoApprove: boolean): Rule[] {
  const rules: Rule[] = []
  if (autoApprove) {
    rules.push({ action: "edit", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "allow" })
  }
  rules.push({ action: "subagent", resource: "*", effect: "deny" })
  return rules
}

/**
 * The lead's permission layer. Last match wins, so the broad denies come first.
 * Ported from mihneaptu/opencode-fusion, which proved the shape on V1: the
 * point is that "delegates or does nothing" is mechanical, not advisory.
 */
function leadRules(enforcement: Enforcement, shellAllowlist: readonly string[], sidekickAgent: string): Rule[] {
  if (enforcement === "off") return []
  const rules: Rule[] = [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]
  // "edits" still allows the built-in subagent path to the sidekick; in "full"
  // the persistent `sidekick` tool is the only delegation path at all.
  if (enforcement === "edits") {
    rules.push({ action: "subagent", resource: sidekickAgent, effect: "allow" })
  }
  if (enforcement === "full") {
    rules.push(
      { action: "grep", resource: "*", effect: "deny" },
      { action: "glob", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      ...shellAllowlist.map((resource): Rule => ({ action: "shell", resource, effect: "allow" })),
    )
  }
  return rules
}

/** `*` is the only wildcard; everything else in the pattern is literal. */
const wildcard = (pattern: string, value: string): boolean =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  ).test(value)

/** Last matching rule wins; undefined when nothing matches. */
const decide = (rules: readonly Rule[], action: string, resource: string): Rule["effect"] | undefined => {
  let effect: Rule["effect"] | undefined
  for (const rule of rules) {
    if (wildcard(rule.action, action) && wildcard(rule.resource, resource)) effect = rule.effect
  }
  return effect
}

const LEAD_INTRO = `You are the lead model of a paired session.

A cheaper, fully capable sidekick model works beside you. It has its own tools,
its own context, and its own session — it can read, edit, search and run shell
commands. You own the task.

Operating rules:
- Default to delegation. Send mechanical work to the sidekick through the
  \`sidekick\` tool: implementation, mechanical refactors, running builds and
  tests, chasing errors, gathering facts across many files.
- Do the work only you can do: read the plan into shape, resolve ambiguity,
  make the design decisions, adjudicate trade-offs, and review what comes back.
- Read only what you must. Ask the sidekick for a summary instead of reading
  twenty files yourself.
- Keep the sidekick's report as your source of truth for what changed; verify
  the parts that decide correctness.
- Write the sidekick's task briefs with the specificity you would want: exact
  files, exact intent, exact done condition.`

const WORKING_WITH_SIDEKICK = `Working with the sidekick:
- Handoff reports end with the list of files the sidekick changed — review
  those, not just the summary.
- \`block: false\` runs the handoff in the background; its report arrives as a
  follow-up message.
- \`action: "status"\` shows whether a handoff is running, \`action: "cancel"\`
  stops it.`

/** The lead's system prompt, generated to match what enforcement actually allows. */
function leadSystem(enforcement: Enforcement, shellAllowlist: readonly string[]): string {
  const capabilities =
    enforcement === "full"
      ? `What you can do yourself:
- You cannot edit files, and you cannot use grep or glob.
- The only shell commands you can run are: ${shellAllowlist.map((pattern) => `\`${pattern}\``).join(", ")}.
  A trailing \`*\` means prefix match.
- The built-in subagent tool is disabled; the \`sidekick\` tool is your only
  delegate. Anything else — search, edits, builds, tests — goes to the sidekick.
- Do not attempt denied tools: they will be refused and waste a turn.`
      : enforcement === "edits"
        ? `What you can do yourself:
- You cannot edit files; every change goes through the sidekick.
- You may read, search and run shell commands to inspect and verify.`
        : `What you can do yourself:
- Nothing is enforced. Edit files yourself only when the change is small,
  already understood, and cheaper to do than to describe.`
  return [LEAD_INTRO, capabilities, WORKING_WITH_SIDEKICK].join("\n\n")
}

/** Surfaced when the permission hook denies a lead action at call time. */
const delegationNudge = (action: string): string =>
  `Fusion: the lead may not use "${action}". Delegate this to the sidekick with the \`sidekick\` tool.`
