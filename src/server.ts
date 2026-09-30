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
import { DEFAULT_PAIR, LEAD_AGENT, SIDEKICK_AGENT, describeModelRef, normalizePair, type FusionPair, type ModelRef } from "./pair.ts"
import { DELEGATION_NUDGE, LEAD_SYSTEM, SIDEKICK_SYSTEM } from "./prompts.ts"
import { Fusion } from "./rpc.ts"

const PAIR_KEY = "pair"
const CHILDREN_KEY = "sidekick-sessions"

type AgentModel = NonNullable<Agent.Info["model"]>
type StoredJson = Parameters<Plugin.Context["storage"]["set"]>[1]
type UnknownRecord = Record<string, unknown>

/**
 * How hard the delegation policy is enforced.
 * - "full": the lead cannot write files and cannot sweep the repo (edit/grep/glob denied),
 *   its shell is deny-by-default with a small allowlist, and it may only delegate to its sidekick.
 * - "edits": the lead cannot write files; everything else is untouched.
 * - "off": prompts only.
 */
type Enforcement = "full" | "edits" | "off"

type Options = {
  readonly enforce?: Enforcement
  readonly leadAgent?: string
  readonly sidekickAgent?: string
  /** Extra shell patterns the lead may run, appended to the default allowlist. */
  readonly allowShell?: readonly string[]
}

/** Commands the lead keeps: cheap verification and inspection, nothing that writes. */
const DEFAULT_SHELL_ALLOWLIST = ["git status*", "git diff --stat*", "git diff HEAD --stat*", "git log --oneline*"]

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined

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

/**
 * The lead's permission layer. Last match wins, so the broad denies come first.
 * Ported from mihneaptu/opencode-fusion, which proved the shape on V1: the
 * point is that "delegates or does nothing" is mechanical, not advisory.
 */
function leadPermissions(
  enforcement: Enforcement,
  shellAllowlist: readonly string[],
  sidekickAgent: string,
): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  if (enforcement === "off") return []
  const permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "subagent", resource: sidekickAgent, effect: "allow" },
  ]
  if (enforcement === "full") {
    permissions.push(
      { action: "grep", resource: "*", effect: "deny" },
      { action: "glob", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      ...shellAllowlist.map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
    )
  }
  return permissions
}

/** Text of the last assistant message in a transcript, whatever the envelope looks like. */
function lastAssistantText(transcript: unknown): string {
  const root = Array.isArray(transcript) ? transcript : (asRecord(transcript)?.messages as unknown[] | undefined) ?? []
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const message = asRecord(root[index])
    if (!message || message.role !== "assistant") continue
    const parts = Array.isArray(message.content)
      ? message.content
      : Array.isArray(message.parts)
        ? message.parts
        : Array.isArray(message.message)
          ? message.message
          : []
    const text = parts
      .map((part) => {
        const record = asRecord(part)
        return record?.type === "text" && typeof record.text === "string" ? record.text : ""
      })
      .filter(Boolean)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return ""
}

function normalizeChildren(value: unknown): Record<string, string> {
  const record = asRecord(value) ?? {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) if (typeof entry === "string") out[key] = entry
  return out
}

const plugin: Plugin.Plugin = {
  id: "opencode-fusion",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const enforcement: Enforcement = options.enforce ?? "full"
    const leadAgent = options.leadAgent ?? LEAD_AGENT
    const sidekickAgent = options.sidekickAgent ?? SIDEKICK_AGENT
    const shellAllowlist = [...DEFAULT_SHELL_ALLOWLIST, ...(options.allowShell ?? [])]
    trace("setup:start", { enforcement })

    const storedPair = normalizePair(await ctx.storage.get(PAIR_KEY))
    trace("pair:loaded", { configured: Boolean(storedPair) })
    let pair: FusionPair = storedPair ?? { ...DEFAULT_PAIR, leadAgent, sidekickAgent }

    // lead session -> sidekick session, kept across restarts.
    const children = new Map<string, string>(Object.entries(normalizeChildren(await ctx.storage.get(CHILDREN_KEY))))
    const persistChildren = async () => ctx.storage.set(CHILDREN_KEY, toStored(Object.fromEntries(children)))


    const toAgentModel = (ref: ModelRef): AgentModel =>
      ({ id: ref.modelID, providerID: ref.providerID, ...(ref.variant ? { variant: ref.variant } : {}) }) as AgentModel

    // One transform reading the captured `pair`: the documented way to change a
    // registration later is to mutate the closure and call reload(). It replays
    // on every reload, so it stays cheap and idempotent.
    let sawAgents = false
    const agents = await ctx.agent.transform((editor) => {
      trace("transform:visible", editor.list().map((agent) => String(agent.id)))
      editor.update(leadAgent, (lead) => {
        lead.model = toAgentModel(pair.lead)
        lead.system = LEAD_SYSTEM
        lead.permissions = leadPermissions(enforcement, shellAllowlist, sidekickAgent)
        sawAgents = true
      })
      editor.update(sidekickAgent, (sidekick) => {
        sidekick.model = toAgentModel(pair.sidekick)
        sidekick.system = SIDEKICK_SYSTEM
        sidekick.mode = "subagent"
        sidekick.permissions = [
          { action: "edit", resource: "*", effect: "allow" },
          { action: "shell", resource: "*", effect: "allow" },
          { action: "subagent", resource: "*", effect: "deny" },
        ]
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
        const listed = await ctx.agent.list()
        const agents: AgentInfo[] = listed.data ?? []
        trace("agents:listed", agents.map((agent) => `${agent.id}=${agent.model?.id ?? "none"}`))
        const stale = (id: string, ref: ModelRef) => {
          const found = agents.find((agent) => agent.id === id)
          return Boolean(found) && found?.model?.id !== ref.modelID
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
      const existing = children.get(leadSessionID)
      if (existing) return existing
      const created = await ctx.session.create({
        agent: sidekickAgent,
        model: toAgentModel(pair.sidekick),
        title: `Fusion sidekick · ${pair.sidekick.modelID}`,
        metadata: { fusionLeadSession: leadSessionID },
      })
      const id = String(created.id)
      children.set(leadSessionID, id)
      await persistChildren()
      return id
    }

    const tools = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "fusion", description: "Fusion lead + sidekick pairing" })
      editor.add({
        name: "sidekick",
        description:
          "Delegate work to the paired sidekick model. The sidekick is a full agent with its own persistent context and toolset. " +
          "Use it for implementation, refactors, running builds and tests, and searching across many files. " +
          "Foreground calls wait for the report; `block: false` returns immediately and the report arrives as a follow-up message. " +
          "Pass `reset: true` to start a fresh sidekick context.",
        input: {
          type: "object",
          properties: {
            message: { type: "string", description: "What the sidekick should do, with files and a done condition." },
            block: { type: "boolean", description: "Wait for the report. Default true." },
            reset: { type: "boolean", description: "Discard the current sidekick context and start over." },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = (input ?? {}) as { message?: unknown; block?: unknown; reset?: unknown }
          const message = typeof args.message === "string" ? args.message : ""
          if (!message) return { content: "sidekick: `message` is required" }
          const leadSessionID = String(context.sessionID)
          if (args.reset === true) {
            children.delete(leadSessionID)
            await persistChildren()
          }
          const sessionID = await ensureSidekickSession(leadSessionID)
          await ctx.session.prompt({ sessionID, text: message })
          if (args.block !== false) {
            await ctx.session.wait({ sessionID })
            const report = lastAssistantText(await ctx.session.context({ sessionID }))
            return { content: report || "sidekick: finished with no text report" }
          }
          void (async () => {
            try {
              await ctx.session.wait({ sessionID })
              const report = lastAssistantText(await ctx.session.context({ sessionID }))
              await ctx.session.synthetic({
                sessionID: leadSessionID,
                text: `<sidekick_report session="${sessionID}">\n${report || "no text report"}\n</sidekick_report>`,
              })
            } catch (error) {
              console.warn(`[fusion] sidekick background report failed: ${String(error)}`)
            }
          })()
          return { content: `sidekick started in session ${sessionID}; its report will arrive as a follow-up message.` }
        },
      })
    })

    trace("tools:registered")

    /**
     * Backstop for the permission layer. mihneaptu/opencode-fusion was archived
     * partly because OpenCode 2 leaked a denied `edit` tool to the plan agent;
     * this hook denies at call time whatever the config resolved to.
     */
    const permissions =
      enforcement === "off"
        ? undefined
        : await ctx.permission.hook("evaluate", (event) => {
            if (event.agent !== leadAgent) return
            if (event.action !== "edit") return
            event.effect = "deny"
            event.message = DELEGATION_NUDGE
          })

    trace("permissions:ready", { enforcement })

    const rpc = await ctx.rpc.register(Fusion, {
      getPair: async () => ({
        configured: normalizePair(await ctx.storage.get(PAIR_KEY)) !== undefined,
        pair: { ...pair, leadAgent, sidekickAgent },
      }),
      setPair: async (input) => {
        const next = normalizePair(input)
        if (!next) return { configured: false, pair: { ...pair, leadAgent, sidekickAgent } }
        pair = { ...next, leadAgent, sidekickAgent }
        await ctx.storage.set(PAIR_KEY, toStored(pair))
        await ctx.agent.reload()
        await rpc.events.emit("pairChanged", { lead: pair.lead, sidekick: pair.sidekick })
        return { configured: true, pair }
      },
      apply: async () => {
        await ctx.agent.reload()
        return { applied: true }
      },
    })

    // Late pass for the cold-start ordering problem above: config agents are
    // registered after setup, and only a reload replays our transform.
    const latePass = setTimeout(() => void ensureApplied(), 400)

    // Also re-apply whenever the agent list changes underneath us.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "agent.updated") void ensureApplied()
        }
      } catch {
        /* the stream ends at shutdown */
      }
    })()

    trace("rpc:registered")

    console.info(
      `[fusion] ready — lead ${describeModelRef(pair.lead)} (${leadAgent}) · sidekick ${describeModelRef(pair.sidekick)} (${sidekickAgent})` +
        (storedPair ? "" : " · no pair picked yet: run /fusion"),
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
