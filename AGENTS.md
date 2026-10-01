# opencode-fusion

Devin-Fusion-style lead + sidekick model pairing for OpenCode V2: a server
plugin (`src/server.ts`), a TUI plugin (`src/tui.ts` + `src/status.tsx` +
`src/keymap.tsx`), a shared RPC contract (`src/rpc.ts`), and helper modules
(`src/pair.ts`, `src/presets.ts`, `src/pairing.ts`, `src/statusline.ts`,
`src/policy.ts`, `src/prompts.ts`, `src/handoffs.ts`, `src/registry.ts`,
`src/sidekick-sessions.ts`, `src/sidekick-state.ts`, `src/costs.ts`,
`src/savings.ts`, `src/version.ts`).

`GLOSSARY.md` names the domain terms and the module that owns each one.

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
  a `.ts` module. Both now hold wiring only: the status sentence's predicate and
  text live in `src/statusline.ts`, the `/fusion` walk in `src/pairing.ts`.
- `src/sidekick-state.ts` takes structural session types and imports nothing, so
  the TUI can hand it the host's own `SessionInfo[]` with no adapter type.
- Test files import sources with explicit `.ts` extensions
  (`import { normalizePair } from "../src/pair.ts"`).

## Effect architecture (effect 4.0.0-rc.112)

The server plugin is Effect-native: `src/server.ts` is the only module with a
runtime `@opencode/*` import (`Plugin.define` from `@opencode/plugin/effect`,
`Tool.Error` from `@opencode/schema/tool`). All wiring lives in `src/setup.ts`
(`fusionSetup(ctx, deps): Effect<void, never, Scope>`), which is JSX-free and
type-only on `@opencode/*`, so tests drive it against a structural fake
`Plugin.Context`.

Services are `Context.Service` tags composed as Layers and built once per
plugin setup in the plugin scope: `FusionStorage`/`FusionHost` base
(`src/host-adapter.ts` owns every branded-type cast — `Session.ID`,
`Agent.ID`, `Model.Ref`, and the storage JSON value type), then `Registry` and
`PairState`, then `SidekickSessionsService`, then `HandoffService`
(`Layer.provideMerge` chains; `Layer.build` memoizes construction). Callbacks
close over the built service instances.

`src/host.ts` holds the structural seams and the Promise→Effect adapters the
legacy facades use (`tryPromise`; the wait adapter forwards an AbortSignal,
`catch` preserves the original rejection). Modules needing serialization use
`Semaphore.make(1)`/`withPermits` (registry write queue, per-lead session
locks via `Semaphore.makeUnsafe`, pair-state save gate). Semaphore wakes are
scheduled through the runtime dispatcher, so the legacy facades run with a
microtask `MixedScheduler` (`facadeScheduler` in host.ts) to keep the old
prompt write-ordering semantics.

`makeHandoffs` forks background report monitors with
`Effect.forkIn(capturedPluginScope, { startImmediately: true })`; the
foreground wait is `Effect.raceFirst` of wait vs timeout vs the compatibility
signal; per-call progress fibers fork into a call-scoped `Scope`.
`createHandoffs` owns a closeable `Scope` and exposes `dispose()`.

The TUI host is Promise-only: `src/tui-runtime.ts` bridges one
`ManagedRuntime` + owned `Scope` per setup (`withTuiRuntime` releases
acquired disposers on setup failure; `dispose()` is idempotent and always
disposes the runtime). All TUI jobs — including wizard dialog adapters — run
through the scope-tracked `runPromise`, so follow-up callbacks and jobs are scoped to the plugin's lifetime and
reject rather than touch the host after unload.

Native `Tool.Context` has no `signal`: tool cancellation is Effect
interruption; the legacy facade still accepts an external `AbortSignal`.

Verify with `npm run check` (tsc + node --test). Server/TUI lifecycle tests run
`fusionSetup` / the bridge under a persistent `ManagedRuntime` + manual `Scope`.
