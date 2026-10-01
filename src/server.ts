/**
 * Server-side half of Fusion.
 *
 * Owns the pair, pushes it onto the two configured agents, enforces the
 * delegation policy, and keeps one persistent sidekick session per lead
 * session so handoffs stay cheap.
 *
 * Type-only imports on purpose: no runtime dependency on `@opencode/*`.
 */
import type { Plugin } from "@opencode/plugin"
import type { Agent } from "@opencode/plugin"
import type { AgentInfo } from "@opencode/client"
import { appendFileSync } from "node:fs"
import {
  LEAD_AGENT,
  SIDEKICK_AGENT,
  describeModelRef,
  normalizePair,
  sameModel,
  toHostModel,
  type FusionPair,
  type ModelRef,
} from "./pair.ts"
import { SIDEKICK_SYSTEM } from "./prompts.ts"
import { DEFAULT_SHELL_ALLOWLIST, leadPolicy, sidekickRules, type Enforcement } from "./policy.ts"
import { versionWarning } from "./version.ts"
import { Fusion } from "./rpc.ts"
import { createHandoffs, type SidekickHost, type SidekickSessions } from "./handoffs.ts"
import { createRegistry, type SidekickStorage } from "./registry.ts"

const PAIR_KEY = "pair"

type StoredJson = Parameters<Plugin.Context["storage"]["set"]>[1]

/**
 * The one place the host's branded model type meets the pair's structural one:
 * `pair.ts` owns the conversion, the agent transform needs the host's brand.
 * Same single-boundary cast pattern as `toStored`.
 */
type AgentModel = NonNullable<Agent.Info["model"]>
const asAgentModel = (ref: ModelRef): AgentModel => toHostModel(ref) as AgentModel

type Options = {
  readonly enforce?: Enforcement
  readonly leadAgent?: string
  readonly sidekickAgent?: string
  /** Extra shell patterns the lead may run, appended to the default allowlist. */
  readonly allowShell?: readonly string[]
  /**
   * Let the sidekick edit files and run shell commands without asking. Default
   * true: a permission prompt in the sidekick's session is easy to miss and
   * stalls the handoff.
   */
  readonly sidekickAutoApprove?: boolean
  /**
   * Seconds a foreground `sidekick` call waits before detaching to the
   * background; the report still arrives as a follow-up message. Default 1800.
   */
  readonly blockTimeoutSeconds?: number
}

// Opt-in diagnostic trace: set FUSION_TRACE to a file path to record how far
// the plugin gets. Off unless asked, and never allowed to break setup.
const trace = (step: string, detail?: unknown) => {
  const target = process.env.FUSION_TRACE
  if (!target) return
  try {
    appendFileSync(target, `${new Date().toISOString()} ${step} ${detail ? JSON.stringify(detail) : ""}\n`)
  } catch {
    /* tracing must never break the plugin */
  }
}

/** Stored values are plain JSON; our interfaces are not index-signatured. */
const toStored = (value: unknown): StoredJson => value as StoredJson

const plugin: Plugin.Plugin = {
  id: "opencode-fusion",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const enforcement: Enforcement = options.enforce ?? "full"
    const leadAgent = options.leadAgent ?? LEAD_AGENT
    const sidekickAgent = options.sidekickAgent ?? SIDEKICK_AGENT
    const shellAllowlist = [...DEFAULT_SHELL_ALLOWLIST, ...(options.allowShell ?? [])]
    const sidekickAutoApprove = options.sidekickAutoApprove ?? true
    const blockTimeoutSeconds = options.blockTimeoutSeconds ?? 1800
    // One policy object drives the agent transform and the permission hook, so
    // the rules, the lead's prompt and the call-time check cannot drift.
    const policy = leadPolicy(enforcement, shellAllowlist, sidekickAgent)
    trace("setup:start", { enforcement })

    const version = versionWarning(ctx.app?.version)
    if (version) {
      console.warn(`[fusion] ${version}`)
      trace("version:untested", { version: ctx.app?.version })
    }

    const storedPair = normalizePair(await ctx.storage.get(PAIR_KEY))
    trace("pair:loaded", { configured: Boolean(storedPair) })
    let pair: FusionPair | undefined = storedPair && { ...storedPair, leadAgent, sidekickAgent }

    // The persistent lead→sidekick registry. The storage adapter owns the
    // StoredJson cast; the registry owns both keys, the cap and the pruning.
    const storage: SidekickStorage = {
      get: (key) => ctx.storage.get(key),
      set: async (key, value) => {
        await ctx.storage.set(key, toStored(value))
      },
    }
    const registry = await createRegistry(storage)

    // One transform reading the captured `pair`: the documented way to change a
    // registration later is to mutate the closure and call reload(). It replays
    // on every reload, so it stays cheap and idempotent.
    let sawAgents = false
    const agents = await ctx.agent.transform((editor) => {
      trace("transform:visible", editor.list().map((agent) => String(agent.id)))
      editor.update(leadAgent, (lead) => {
        if (pair) lead.model = asAgentModel(pair.lead)
        lead.system = policy.system
        lead.permissions = [...lead.permissions, ...policy.rules]
        sawAgents = true
      })
      editor.update(sidekickAgent, (sidekick) => {
        if (pair) sidekick.model = asAgentModel(pair.sidekick)
        sidekick.system = SIDEKICK_SYSTEM
        sidekick.mode = "subagent"
        sidekick.permissions = [...sidekick.permissions, ...sidekickRules(sidekickAutoApprove)]
        sawAgents = true
      })
    })

    trace("agents:transformed", { sawAgents })

    /**
     * Plugins load before config agents are registered, so the first replay sees
     * nothing (`editor.get` is undefined). Re-apply once they land — idempotent:
     * reload only while an agent is still missing the model we expect.
     */
    let applying = false
    let attempts = 0
    let lastAttempt = 0
    const ensureApplied = async () => {
      if (applying) return
      // Our own reload emits agent.updated, so this must be capped, not reactive-only.
      if (attempts >= 5 || Date.now() - lastAttempt < 400) return
      attempts += 1
      lastAttempt = Date.now()
      applying = true
      try {
        if (!pair) return
        const listed = await ctx.agent.list()
        const agents: AgentInfo[] = listed.data ?? []
        trace("agents:listed", agents.map((agent) => `${agent.id}=${agent.model?.id ?? "none"}`))
        // Registered but not on the pair's model counts as drift; not registered
        // at all does not, or this would reload forever on a missing agent.
        const stale = (id: string, ref: ModelRef) => {
          const found = agents.find((agent) => agent.id === id)
          return Boolean(found) && !sameModel(ref, found?.model)
        }
        if (stale(leadAgent, pair.lead) || stale(sidekickAgent, pair.sidekick)) {
          trace("agents:reapply", { attempt: attempts })
          await ctx.agent.reload()
        }
      } catch (error) {
        trace(`agents:reapply:failed ${String(error)}`)
      } finally {
        applying = false
      }
    }

    const ensureSidekickSession = async (leadSessionID: string): Promise<string> => {
      const existing = registry.current(leadSessionID)
      if (existing) {
        // LRU touch: recording an existing child moves it to the newest end.
        // Await the write so the touch is durable before the session is reused.
        await registry.record(leadSessionID, existing)
        try {
          const session = await ctx.session.get({ sessionID: existing })
          if (!session.time.archived) {
            // A re-pair leaves the stored session on the old model; re-sync it.
            if (pair && !sameModel(pair.sidekick, session.model)) {
              await ctx.session.switchModel({ sessionID: existing, model: toHostModel(pair.sidekick) })
            }
            return existing
          }
        } catch {
          /* the stored session is gone */
        }
        await registry.reset(leadSessionID)
      }
      const created = await ctx.session.create({
        agent: sidekickAgent,
        ...(pair ? { model: toHostModel(pair.sidekick) } : {}),
        title: pair ? `Fusion sidekick · ${pair.sidekick.modelID}` : "Fusion sidekick",
        metadata: { fusionLeadSession: leadSessionID },
      })
      const id = String(created.id)
      // Await the write: the handoff may start as soon as this returns.
      await registry.record(leadSessionID, id)
      return id
    }

    // Seams the Handoff lifecycle module is built on: the host calls go to
    // `ctx`, session bookkeeping to the registry, which sits behind this
    // interface.
    const host: SidekickHost = {
      prompt: (input) => ctx.session.prompt({ sessionID: input.sessionID, text: input.text, metadata: input.metadata }),
      wait: (sessionID, waitOptions) => ctx.session.wait({ sessionID }, { signal: waitOptions?.signal }),
      context: (sessionID) => ctx.session.context({ sessionID }),
      interrupt: (sessionID) => ctx.session.interrupt({ sessionID }),
      synthetic: async (input) => {
        await ctx.session.synthetic({ sessionID: input.sessionID, text: input.text, resume: input.resume })
      },
      workingDiff: async () => (await ctx.vcs.diff({ mode: "working" })).data,
    }

    const sessions: SidekickSessions = {
      ensure: (leadSessionID) => ensureSidekickSession(leadSessionID),
      current: (leadSessionID) => registry.current(leadSessionID),
      forget: (leadSessionID) => registry.reset(leadSessionID),
    }

    const handoffs = createHandoffs({ host, sessions, blockTimeoutSeconds })

    const tools = await ctx.tool.transform((editor) => {
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
        execute: async (input, context) => {
          if (String(context.agent) !== leadAgent) {
            return { content: `sidekick: only the ${leadAgent} agent can delegate to the sidekick` }
          }
          const args = (input ?? {}) as { action?: unknown; message?: unknown; block?: unknown; reset?: unknown }
          const leadSessionID = String(context.sessionID)
          const action = args.action === "status" || args.action === "cancel" ? args.action : "delegate"

          if (action === "status") return { content: handoffs.status(leadSessionID) }
          if (action === "cancel") return { content: await handoffs.cancel(leadSessionID) }

          const message = typeof args.message === "string" ? args.message : ""
          if (!message) return { content: "sidekick: `message` is required for action \"delegate\"" }
          const progress = async (update: Record<string, unknown>) => {
            try {
              await context.progress(update)
            } catch {
              /* progress is cosmetic */
            }
          }
          return handoffs.delegate({
            leadSessionID,
            message,
            block: args.block !== false,
            reset: args.reset === true,
            signal: context.signal,
            progress,
          })
        },
      })
    })

    trace("tools:registered")

    /**
     * Backstop for the lead's permission layer. A configured `deny` is final and
     * never reaches this hook — it only runs for allow/ask decisions — so it
     * re-checks the policy at call time, covering the window before the agent
     * transform lands or a tool leaks through. It only ever tightens.
     */
    const permissions =
      enforcement === "off"
        ? undefined
        : await ctx.permission.hook("evaluate", (event) => {
            if (event.agent === undefined || String(event.agent) !== leadAgent) return
            const denial = policy.deny(event.action, event.resources)
            if (denial === undefined) return
            event.effect = "deny"
            event.message = denial
          })

    trace("permissions:ready", { enforcement })

    const rpc = await ctx.rpc.register(Fusion, {
      getPair: async () => ({
        configured: pair !== undefined,
        ...(pair ? { pair } : {}),
        leadAgent,
        sidekickAgent,
      }),
      setPair: async (input) => {
        const next = normalizePair(input)
        if (!next) return { configured: pair !== undefined, ...(pair ? { pair } : {}), leadAgent, sidekickAgent }
        pair = { ...next, leadAgent, sidekickAgent }
        await ctx.storage.set(PAIR_KEY, toStored(pair))
        await ctx.agent.reload()
        await rpc.events.emit("pairChanged", { lead: pair.lead, sidekick: pair.sidekick })
        return { configured: true, pair, leadAgent, sidekickAgent }
      },
      apply: async () => {
        await ctx.agent.reload()
        return { applied: true }
      },
      sidekicks: async (input) => {
        const sessionID = String((input as { sessionID: string }).sessionID)
        return {
          current: registry.current(sessionID),
          sessionIDs: registry.sessions(sessionID),
          running: handoffs.running(sessionID),
        }
      },
    })
    handoffs.setEmitter((event) => {
      void rpc.events.emit("handoffChanged", event).catch(() => {})
    })

    // Late pass for the cold-start ordering problem above: config agents are
    // registered after setup, and only a reload replays our transform.
    const latePass = setTimeout(() => void ensureApplied(), 400)

    // Also re-apply whenever the agent list changes underneath us.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "agent.updated") {
            void ensureApplied()
          } else if (event.type === "session.deleted") {
            // Pruning is fire-and-forget here, but a failed write must be
            // handled explicitly rather than surface as an unhandled rejection.
            void registry.forget(String(event.data.sessionID)).catch((error) => {
              trace(`registry:forget:failed ${String(error)}`)
            })
          } else if (event.type === "session.step.ended") {
            handoffs.onStep(String(event.data.sessionID), event.data)
          }
        }
      } catch {
        /* the stream ends at shutdown */
      }
    })()

    trace("rpc:registered")

    console.info(
      pair
        ? `[fusion] ready — lead ${describeModelRef(pair.lead)} (${leadAgent}) · sidekick ${describeModelRef(pair.sidekick)} (${sidekickAgent})`
        : `[fusion] ready — no pair picked yet: run /fusion — agents use OpenCode's default model`,
    )

    return async () => {
      clearTimeout(latePass)
      controller.abort()
      await tools.dispose()
      await agents.dispose()
      await rpc.dispose()
      if (permissions) await permissions.dispose()
    }
  },
}

export default plugin
