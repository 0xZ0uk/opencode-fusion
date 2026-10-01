/**
 * Server-side half of Fusion.
 *
 * Owns the pair, pushes it onto the two configured agents, enforces the
 * delegation policy, and keeps one persistent sidekick session per lead
 * session so handoffs stay cheap.
 *
 * Type-only imports on purpose: no runtime dependency on `@opencode/*`.
 */
import type { Plugin } from "@opencode/plugin/effect"
import type { Agent } from "@opencode/schema/agent"
import type { Tool } from "@opencode/schema/tool"
import { appendFileSync } from "node:fs"
import { Context, Effect, Layer, Stream, type Scope } from "effect"
import { describeModelRef, type FusionPair, type ModelRef } from "./pair.ts"
import { SIDEKICK_SYSTEM } from "./prompts.ts"
import { DEFAULT_SHELL_ALLOWLIST, leadPolicy, sidekickRules } from "./policy.ts"
import { versionWarning } from "./version.ts"
import { Fusion } from "./rpc.ts"
import { HandoffService, makeHandoffs, type StepEnded } from "./handoffs.ts"
import { makeRegistry, Registry } from "./registry.ts"
import { makeSidekickSessions, SidekickSessionsService } from "./sidekick-sessions.ts"
import { makePairState, PairState } from "./pair-state.ts"
import { makeAgentSync } from "./agent-sync.ts"
import { normalizeOptions } from "./options.ts"
import { agentList, asAgentModel, fusionHost, storageFromContext } from "./host-adapter.ts"
import { FusionHost, FusionStorage } from "./host.ts"

export interface SetupDeps {
  readonly toolError: (message: string, error?: unknown) => Tool.Error
  readonly trace?: (step: string, detail?: unknown) => void
}

// Opt-in diagnostic trace: set FUSION_TRACE to a file path to record how far
// the plugin gets. Off unless asked, and never allowed to break setup.
const fileTrace = (step: string, detail?: unknown) => {
  const target = process.env.FUSION_TRACE
  if (!target) return
  try {
    appendFileSync(target, `${new Date().toISOString()} ${step} ${detail ? JSON.stringify(detail) : ""}\n`)
  } catch {
    /* tracing must never break the plugin */
  }
}

const setup = Effect.fn("fusionSetup")(function* (
  ctx: Plugin.Context,
  deps: SetupDeps,
): Effect.fn.Return<void, unknown, Scope.Scope> {
    const trace = deps.trace ?? fileTrace
    const options = normalizeOptions(ctx.options)
    const enforcement = options.enforce
    const leadAgent = options.leadAgent
    const sidekickAgent = options.sidekickAgent
    const shellAllowlist = [...DEFAULT_SHELL_ALLOWLIST, ...options.allowShell]
    const sidekickAutoApprove = options.sidekickAutoApprove
    const blockTimeoutSeconds = options.blockTimeoutSeconds
    // One policy object drives the agent transform and the permission hook, so
    // the rules, the lead's prompt and the call-time check cannot drift.
    const policy = leadPolicy(enforcement, shellAllowlist, sidekickAgent)
    trace("setup:start", { enforcement })

    const version = versionWarning(ctx.app?.version)
    if (version) {
      console.warn(`[fusion] ${version}`)
      trace("version:untested", { version: ctx.app?.version })
    }

    let rpc!: {
      events: {
        emit(name: "pairChanged", data: { lead: ModelRef; sidekick: ModelRef }): Effect.Effect<void, unknown>
      }
    }

    // The persistent lead→sidekick registry. The storage adapter owns the
    // StoredJson cast; the registry owns both keys, the cap and the pruning.
    const base = Layer.mergeAll(
      Layer.succeed(FusionStorage, storageFromContext(ctx)),
      Layer.succeed(FusionHost, fusionHost(ctx)),
    )
    const registryLayer = Layer.effect(
      Registry,
      Effect.flatMap(FusionStorage, (storage) => makeRegistry(storage)),
    )
    const pairLayer = Layer.effect(
      PairState,
      Effect.flatMap(FusionStorage, (storage) =>
        makePairState({
          storage,
          leadAgent,
          sidekickAgent,
          reload: ctx.agent.reload(),
          changed: (saved: FusionPair): Effect.Effect<void, unknown> =>
            Effect.suspend(() => rpc.events.emit("pairChanged", { lead: saved.lead, sidekick: saved.sidekick })),
        }),
      ),
    )
    const stateLayer = Layer.mergeAll(registryLayer, pairLayer)
    // The reuse policy lives in its own module, behind the same
    // `SidekickSessions` interface the handoff lifecycle depends on.
    const sessionsLayer = Layer.effect(
      SidekickSessionsService,
      Effect.gen(function* () {
        const host = yield* FusionHost
        const registry = yield* Registry
        const pair = yield* PairState
        return yield* makeSidekickSessions({
          host,
          registry,
          sidekickAgent,
          currentPair: () => pair.current(),
        })
      }),
    )
    const handoffsLayer = Layer.effect(
      HandoffService,
      Effect.gen(function* () {
        const host = yield* FusionHost
        const sessions = yield* SidekickSessionsService
        return yield* makeHandoffs({ host, sessions, blockTimeoutSeconds })
      }),
    )
    const withSessions = Layer.provideMerge(sessionsLayer, stateLayer)
    const withHandoffs = Layer.provideMerge(handoffsLayer, withSessions)
    const everything = Layer.provideMerge(withHandoffs, base)
    const built = yield* Layer.build(everything)
    const registry = Context.get(built, Registry)
    const pair = Context.get(built, PairState)
    const handoffs = Context.get(built, HandoffService)
    trace("pair:loaded", { configured: pair.current() !== undefined })

    // One transform reading the captured `pair`: the documented way to change a
    // registration later is to mutate the closure and call reload(). It replays
    // on every reload, so it stays cheap and idempotent.
    let sawAgents = false
    yield* ctx.agent.transform((editor) => {
      const current = pair.current()
      trace("transform:visible", editor.list().map((agent) => String(agent.id)))
      editor.update(leadAgent as Agent.ID, (lead) => {
        if (current) lead.model = asAgentModel(current.lead)
        lead.system = policy.system
        lead.permissions = [...lead.permissions, ...policy.rules]
        sawAgents = true
      })
      editor.update(sidekickAgent as Agent.ID, (sidekick) => {
        if (current) sidekick.model = asAgentModel(current.sidekick)
        sidekick.system = SIDEKICK_SYSTEM
        sidekick.mode = "subagent"
        sidekick.permissions = [...sidekick.permissions, ...sidekickRules(sidekickAutoApprove)]
        sawAgents = true
      })
    })

    trace("agents:transformed", { sawAgents })

    const agentSync = yield* makeAgentSync({
      list: agentList(ctx),
      reload: ctx.agent.reload(),
      pair: () => pair.current(),
      leadAgent,
      sidekickAgent,
      trace,
    })

    // The one place the host's session API meets the plugin's two seams: the
    // handoff lifecycle drives a sidekick turn, the sidekick sessions module
    // decides which session that turn lands in. Both read `pair` late, through
    // the getter below, because `setPair` replaces it after setup.

    yield* ctx.tool.transform((editor) => {
      editor.namespace({ name: "fusion", description: "Fusion lead + sidekick pairing" })
      editor.add({
        name: "sidekick",
        description:
          "Delegate work to the paired sidekick model (action \"delegate\", the default). The sidekick is a full agent " +
          "with its own persistent context and toolset — use it for implementation, refactors, builds and tests, and " +
          "searches across many files. Foreground calls wait for the report; a call that outlives the configured " +
          "timeout detaches to the background and the report arrives as a follow-up message, as does every " +
          "`block: false` report. Reports end with the list of files the sidekick changed. `action: \"status\"` " +
          "lists this session's in-flight handoffs, `action: \"cancel\"` interrupts the sidekick session. " +
          "Pass `reset: true` to start a fresh sidekick context.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["delegate", "status", "cancel"],
              description: "delegate (default), list in-flight handoffs, or interrupt the sidekick session",
            },
            message: { type: "string", description: "What the sidekick should do, with files and a done condition. Required for delegate." },
            block: { type: "boolean", description: "Wait for the report. Default true." },
            reset: { type: "boolean", description: "Discard the current sidekick context and start over." },
          },
          required: [],
          additionalProperties: false,
        },
        execute: (input, context) =>
          Effect.gen(function* () {
            if (String(context.agent) !== leadAgent) {
              return { content: `sidekick: only the ${leadAgent} agent can delegate to the sidekick` }
            }
            const args = (input ?? {}) as { action?: unknown; message?: unknown; block?: unknown; reset?: unknown }
            const leadSessionID = String(context.sessionID)
            const action = args.action === "status" || args.action === "cancel" ? args.action : "delegate"

            if (action === "status") return { content: handoffs.status(leadSessionID) }
            if (action === "cancel") return { content: yield* handoffs.cancel(leadSessionID) }

            const message = typeof args.message === "string" ? args.message : ""
            if (!message) return { content: "sidekick: `message` is required for action \"delegate\"" }
            /* progress is cosmetic */
            const progress = (update: Record<string, unknown>) => context.progress(update)
            return yield* handoffs.delegate({
              leadSessionID,
              message,
              block: args.block !== false,
              reset: args.reset === true,
              progress,
            })
        }).pipe(
          Effect.mapError((error) => deps.toolError(error instanceof Error ? error.message : String(error), error)),
        ),
      })
    })

    trace("tools:registered")

    /**
     * Backstop for the lead's permission layer. A configured `deny` is final and
     * never reaches this hook — it only runs for allow/ask decisions — so it
     * re-checks the policy at call time, covering the window before the agent
     * transform lands or a tool leaks through. It only ever tightens.
     */
    if (enforcement !== "off") {
      yield* ctx.permission.hook("evaluate", (event) =>
        Effect.sync(() => {
          if (event.agent === undefined || String(event.agent) !== leadAgent) return
          const denial = policy.deny(event.action, event.resources)
          if (denial === undefined) return
          event.effect = "deny"
          event.message = denial
        }),
      )
    }

    trace("permissions:ready", { enforcement })

    rpc = yield* ctx.rpc.register(Fusion, {
      getPair: () => Effect.succeed(pair.status()),
      setPair: (input) => pair.setPair(input).pipe(Effect.orDie),
      apply: () => pair.apply().pipe(Effect.orDie),
    })

    // Late pass for the cold-start ordering problem above: config agents are
    // registered after setup, and only a reload replays our transform.
    yield* Effect.forkScoped(Effect.andThen(Effect.sleep("400 millis"), agentSync.ensureApplied))

    // Also re-apply whenever the agent list changes underneath us.
    const pluginScope = yield* Effect.scope
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type === "agent.updated") {
          return Effect.forkIn(pluginScope, { startImmediately: true })(agentSync.ensureApplied).pipe(Effect.asVoid)
        }
        if (event.type === "session.deleted") {
          // Pruning is fire-and-forget here, but a failed write must be
          // handled explicitly rather than surface as an unhandled rejection.
          return Effect.forkIn(pluginScope, { startImmediately: true })(
            registry.forget(String(event.data.sessionID)).pipe(
              Effect.catch((error) => Effect.sync(() => trace(`registry:forget:failed ${String(error)}`))),
            ),
          ).pipe(Effect.asVoid)
        }
        if (event.type === "session.step.ended") {
          handoffs.onStep(String(event.data.sessionID), event.data as StepEnded)
        }
        return Effect.void
      }),
      /* the stream ends at shutdown */
      Effect.catch(() => Effect.void),
      Effect.forkScoped,
    )

    trace("rpc:registered")

    const current = pair.current()
    console.info(
      current
        ? `[fusion] ready — lead ${describeModelRef(current.lead)} (${leadAgent}) · sidekick ${describeModelRef(current.sidekick)} (${sidekickAgent})`
        : `[fusion] ready — no pair picked yet: run /fusion — agents use OpenCode's default model`,
    )
  })

export const fusionSetup = (
  ctx: Plugin.Context,
  deps: SetupDeps,
): Effect.Effect<void, never, Scope.Scope> => setup(ctx, deps).pipe(Effect.orDie)
