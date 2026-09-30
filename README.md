# opencode-fusion

A Devin-Fusion-style pairing for **OpenCode V2**: a frontier **lead** model that plans,
decides and reviews, plus a cheaper **sidekick** that executes in its own persistent
session. You pick the pair from a TUI selector, not from a config file.

Status: working skeleton, verified against OpenCode `2.0.19`.

## What it does

- `/fusion` — pick **lead model → lead effort → sidekick model → sidekick effort** from the
  models OpenCode actually has available, optionally starting from a subscription preset.
  The pair is saved, the agents are re-pointed, and the live session moves onto the lead.
- `/fusion-stats` — sidekick tokens and what they would have cost at lead rates.
- `/fusion-show` (palette) — the active pairing and the live model's variants.
- A `sidekick` tool for the lead: hands work to a **persistent** sidekick session
  (its context survives handoffs), foreground or background.

## Install

Three pieces: two agent definitions, the server plugin, the TUI plugin.

**1. Agent definitions** — OpenCode cannot let a plugin *create* an agent, so both must
exist in config. Copy the examples:

```bash
cp examples/agents/fusion-lead.md     ~/.config/opencode/agents/
cp examples/agents/fusion-sidekick.md ~/.config/opencode/agents/
```

Leave them bare as shipped: the plugin supplies the model, system prompt and permissions
at startup, and replaces them on every `/fusion` pick.

**2. Server plugin** — OpenCode discovers plugin *directories* under `.opencode/plugins/`
(project) or `~/.config/opencode/plugins/` (global), each with an `index.ts`:

```bash
cp -r src ~/.config/opencode/plugins/fusion
```

**3. TUI plugin** — CLI plugins are configured separately, in `cli.json`:

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/opencode-fusion/src/tui.ts"]
}
```

Then restart OpenCode (config loads at startup) and run `/fusion`.

To pass options, load the plugin from config by path instead of copying it into a
discovered `plugins/` directory, so it isn't loaded twice:

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-fusion/src/index.ts",
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

## Enforced vs advised

Enforced, at the permission layer, applied to the lead agent by the plugin. Rules are
appended to the agent's existing permissions, so OpenCode defaults like `.env` read
prompts and external-directory prompts are kept:

- `edit` denied — the lead has no way to change a file except by delegating.
- `grep` and `glob` denied — the lead reads what it asks for, not the whole repo.
- `shell` deny-by-default with a small allowlist (`git status`, `git diff --stat`,
  `git diff HEAD --stat`, `git log --oneline`) plus whatever `allowShell` adds.
- `subagent` denied except the sidekick, so delegation is bounded.
- the `sidekick` tool refuses calls from any agent other than the lead.

`enforce: "edits"` keeps only the edit deny; `enforce: "off"` makes everything advisory.
A `permission.hook("evaluate")` backstop re-checks every lead rule at call time,
covering the window before the agent transform lands (configured denies are final
and never reach the hook).

Advised, in the prompts: brief specificity, review rigour, cost discipline.

## Verified

Against a real `opencode serve` on 2.0.19, with `FUSION_TRACE` pointed at a file:

- plugin loads from `.opencode/plugins/fusion/`, all setup stages run, RPC registers
- `POST /api/rpc/fusion/getPair|setPair|apply` round-trips; the JSON Schemas are enforced
  (`rpc.invalid_input` names the missing key) and storage persists across processes
- a picked pair lands on the agents: `fusion-lead` = `openrouter/muse/6-astra#high` with
  10 permission rules, `fusion-sidekick` = `openrouter/z-ai/glm-5.3-flash` with 3
- `tsc --noEmit` is clean against the real `@opencode/plugin` types

Not yet verified (do these before trusting it):

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
