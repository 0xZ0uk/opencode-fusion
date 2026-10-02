# Glossary

Terminology for this plugin, in the order the code meets it. One line each.

- **pair** — the lead + sidekick model pairing the plugin applies to its two agents (src/pair.ts).
- **lead** — the frontier model that plans, decides and reviews; runs the fusion agent and owns the task.
- **sidekick** — the cheaper model that executes in its own persistent session; runs the sidekick agent as a subagent.
- **model ref** — a stored model selection: providerID + modelID + effort variant (src/pair.ts).
- **effort variant** — the effort/reasoning level on a model ref; absent means the model default.
- **handoff** — one delegated turn: a brief sent to the lead's sidekick session and the report that comes back (src/handoffs.ts).
- **sidekick session** — the persistent session a lead's handoffs reuse, so follow-ups keep their context.
- **current sidekick** — the sidekick session a lead reuses right now; the only lead→sidekick mapping the registry persists.
- **sidekick sessions module** — owns the reuse policy for a lead's current sidekick: touch, archived check, re-pair re-sync, recreate (src/sidekick-sessions.ts).
- **sidekick state** — what the TUI derives from the host's session list: a lead's live sidekick sessions and whether any is running (src/sidekick-state.ts).
- **pairing wizard** — the /fusion flow picking lead model, effort, sidekick model and effort (src/pairing.ts).
- **status line** — the prompt.footer.status sentence shown on lead sessions (src/statusline.ts).
- **status line lifecycle** — what keeps the status line true: the store, the host session snapshot, the session-event revision, and the pair refresh on startup and on `pairChanged` (src/status-lifecycle.ts).
- **Fusion commands** — the three keymap commands and their flows: `/fusion`, `/fusion-stats` and the pairing summary, with the metadata and bindings they register (src/tui-commands.ts).
- **enforcement** — how hard the delegation policy binds the lead: full, edits, off (src/policy.ts).
- **lead policy** — the rules, prompt and call-time check generated from one enforcement level (src/policy.ts).
- **cost card** — what one model costs: its rates, tiers and where the numbers came from (src/costs.ts).
- **savings report** — /fusion-stats: what the sidekick's work cost and what it would have cost at lead rates (src/savings.ts).
- **preset** — a subscription's named lead/sidekick model pairings offered in the wizard (src/presets.ts).
