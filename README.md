# opencode-fusion

A Devin-Fusion-style pairing for **OpenCode V2**: a frontier **lead** model that plans,
decides and reviews, plus a cheaper **sidekick** that executes in its own persistent
session. You pick the pair from a TUI selector, not from a config file.

Status: working skeleton, verified against OpenCode `2.0.19`.

## What it does

- `/fusion` — pick **lead model → lead effort → sidekick model → sidekick effort** from the
  models OpenCode actually has available, optionally starting from a subscription preset.
  The pair is saved, the agents are re-pointed, and the live session moves onto the lead.
  Until a pair is picked the agents keep OpenCode's configured/default model.
- `/fusion-stats` — per-session savings: this lead session's billed cost plus every
  sidekick session created for it, and what the sidekick's work would have cost at lead
  rates (priced per message, context tier included).
- `/fusion-show` (palette) — the active pairing and the live model's variants.
- A `prompt.footer.status` line on lead sessions: `fusion <lead> → <sidekick>`, plus
  `· sidekick running` while a handoff is in flight.
- A `sidekick` tool for the lead: hands work to a **persistent** sidekick session
  (its context survives handoffs), foreground or background. Reports are matched to
  their handoff and end with the list of files the sidekick changed.
- A startup warning (server log + TUI toast) when the OpenCode version falls outside
  the tested range (`>=2.0.19 <2.1.0`) — the plugin API may differ.

## Install

Three pieces: the plugin, two agent definitions, and a restart.

**1. Plugin** — install from GitHub with the built-in plugin manager:

```bash
opencode plugin add github:0xZ0uk/opencode-fusion
```

This loads the server plugin from the package's `.` export; the TUI half loads
automatically from its `./tui` export. Add the same spec to the `plugins` array in
`~/.config/opencode/cli.json` only when connecting to a *remote* OpenCode server.

To update later:

```bash
opencode plugin update opencode-fusion
```

**2. Agent definitions** — OpenCode cannot let a plugin *create* an agent, so both must
exist in config. Fetch the two markdown files — the one place the agents are defined —
and do not also declare them in a config `agents` block:

```bash
curl -fsSL -o ~/.config/opencode/agents/fusion-lead.md \
  https://raw.githubusercontent.com/0xZ0uk/opencode-fusion/main/examples/agents/fusion-lead.md
curl -fsSL -o ~/.config/opencode/agents/fusion-sidekick.md \
  https://raw.githubusercontent.com/0xZ0uk/opencode-fusion/main/examples/agents/fusion-sidekick.md
```

Leave them bare as shipped: the plugin supplies the model, system prompt and permissions
at startup, and replaces them on every `/fusion` pick.

Then restart OpenCode (config loads at startup) and run `/fusion`.

**3. Options** — `plugin add` writes a plain string entry; to pass options, replace it
with the object form:

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "github:0xZ0uk/opencode-fusion",
      "options": {
        "enforce": "full",
        "allowShell": ["bun test*", "pnpm test*"],
        "sidekickAutoApprove": true
      }
    }
  ]
}
```

`sidekickAutoApprove` defaults to `true`, letting the sidekick edit files and run
shell commands without prompting; set it to `false` to have the sidekick's edits
and shell calls follow your normal permission config.

`blockTimeoutSeconds` (default 1800) caps how long a foreground `sidekick` call
waits before the handoff detaches to the background; the report still arrives as
a follow-up message.

### Local development

Load the plugin straight from a checkout — the server half by path in
`opencode.jsonc`, the TUI half by path in `~/.config/opencode/cli.json`:

```jsonc
// opencode.jsonc
{ "plugins": [{ "package": "/absolute/path/to/opencode-fusion/src/index.ts", "options": {} }] }
```

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": ["/absolute/path/to/opencode-fusion/src/tui.ts"] }
```

## The `sidekick` tool

- `action: "delegate"` (default) sends `message` to the sidekick session. Foreground
  waits bounded by `blockTimeoutSeconds`; `block: false` returns immediately.
- `action: "status"` lists this session's in-flight handoffs; `action: "cancel"`
  interrupts the sidekick session. Aborting the lead's turn interrupts the
  sidekick too.
- Reports are matched to their handoff marker, not just "the last reply", and end
  with the changed-file list (with working-tree +A/−D when available).
- The sidekick session persists per lead session: re-picking the pair re-syncs
  its model, archived or deleted sessions are pruned and recreated, and the
  remembered set is a capped LRU. A separate per-lead history remembers every
  sidekick session ever created, so `reset: true` does not hide older sessions
  from `/fusion-stats`.

## Enforced vs advised

Enforced, at the permission layer, applied to the lead agent by the plugin. Rules are
appended to the agent's existing permissions, so OpenCode defaults like `.env` read
prompts and external-directory prompts are kept:

- `edit` denied — the lead has no way to change a file except by delegating.
- `grep` and `glob` denied — the lead reads what it asks for, not the whole repo.
- `shell` deny-by-default with a small allowlist (`git status`, `git diff --stat`,
  `git diff HEAD --stat`, `git log --oneline`) plus whatever `allowShell` adds.
- `subagent` denied entirely in `full` — the `sidekick` tool is the only delegation
  path. `edits` keeps the deny except for the sidekick agent.
- the `sidekick` tool refuses calls from any agent other than the lead.

The lead's system prompt is generated from the enforcement level — in `full` it
lists the allowed shell commands and names the `sidekick` tool as the only
delegate, so the model is told what it can do instead of discovering the denies.

`enforce: "edits"` keeps only the edit deny and the sidekick-scoped subagent
allow; `enforce: "off"` makes everything advisory.
A `permission.hook("evaluate")` backstop re-checks every lead rule at call time,
covering the window before the agent transform lands (configured denies are final
and never reach the hook).

Advised, in the prompts: brief specificity, review rigour, cost discipline.

## Development

```bash
npm run check   # tsc --noEmit + node --test
```

Tests run on plain Node type stripping against the pure modules (`src/pair.ts`,
`src/presets.ts`, `src/pricing.ts`, `src/version.ts`, and the exported helpers of
`src/server.ts`). `src/status.tsx` is the only JSX file.

## Verified

Against a real `opencode serve` on 2.0.19, with `FUSION_TRACE` pointed at a file:

- plugin loads from `.opencode/plugins/fusion/`, all setup stages run, RPC registers
- `POST /api/rpc/fusion/getPair|setPair|apply` round-trips; the JSON Schemas are enforced
  (`rpc.invalid_input` names the missing key) and storage persists across processes
- a picked pair lands on the agents: `fusion-lead` = `openrouter/muse/6-astra#high` with
  10 permission rules, `fusion-sidekick` = `openrouter/z-ai/glm-5.3-flash` with 3
- `tsc --noEmit` and `node --test` are clean against the real `@opencode/plugin` types

Not yet verified (do these before trusting it):

- the `opencode plugin add github:` install path, including the automatic `./tui`
  loading it relies on
- the `prompt.footer.status` slot rendering in a real TUI
- the TUI picker flow itself — no interactive session has exercised the dialogs
- a real lead↔sidekick handoff through the `sidekick` tool (costs tokens)
- whether the permission-hook `message` reaches the model, and whether plugin tools
  appear inside subagent sessions

## Ordering facts that will bite you

Both were found the hard way; they are why `server.ts` has a deferred re-apply.

1. **Plugins load before config agents exist.** During the first `agent.transform` the
   editor cannot see `fusion-lead` at all, so a `get()`-and-mutate transform silently does
   nothing. Use `editor.update(id, fn)` — it applies when the agent appears — and reload
   once the agents have landed.
2. **`ctx.agent.reload()` emits `agent.updated`.** A reactive "reload whenever agents
   change" loop will storm; the re-apply is capped and time-gated for that reason.

## Credit

The enforcement design (edit/grep/glob deny, shell allowlist, bounded delegation), the
subscription presets and the cross-vendor review argument come from
[mihneaptu/opencode-fusion](https://github.com/mihneaptu/opencode-fusion) (MIT), which
proved them on OpenCode 1.x and was archived rather than ported.
