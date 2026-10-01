# opencode-fusion

Devin-Fusion-style lead + sidekick model pairing for OpenCode V2: a server
plugin (`src/server.ts`), a TUI plugin (`src/tui.ts` + `src/status.tsx` +
`src/keymap.tsx`), a shared RPC contract (`src/rpc.ts`), and helper modules
(`src/pair.ts`, `src/presets.ts`, `src/pricing.ts`, `src/version.ts`,
`src/prompts.ts`, `src/handoffs.ts`, `src/registry.ts`).

## Build and verify

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/**/*.test.ts"
npm run check       # both
```

## Testing layout

Tests run on plain Node (>=24) via native TypeScript type stripping — no
bundler, no JSX transform. Consequences:

- Everything testable must live in JSX-free modules that only use
  `import type` from `@opencode/*` (type imports are erased, so the modules
  load without the host's runtime).
- `src/status.tsx` and `src/keymap.tsx` are the only JSX files; neither is
  imported by tests. Keep logic out of them — anything worth testing belongs in
  a `.ts` module.
- Test files import sources with explicit `.ts` extensions
  (`import { normalizePair } from "../src/pair.ts"`).
