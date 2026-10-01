import type { Plugin } from "@opencode/plugin/effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { FusionHostService, FusionStorageService } from "./host.ts"
import type { FileStat, Transcript } from "./handoffs.ts"
import type { HostModel, ModelRef } from "./pair.ts"
import { toHostModel } from "./pair.ts"

type Ctx = Plugin.Context

type StoredJson = Parameters<Ctx["storage"]["set"]>[1]

/** Stored values are plain JSON; our interfaces are not index-signatured. */
export const storageFromContext = (ctx: Ctx): FusionStorageService => ({
  get: (key) => ctx.storage.get(key),
  set: (key, value) => ctx.storage.set(key, value as StoredJson),
})

/**
 * The one place the host's branded model type meets the pair's structural one:
 * `pair.ts` owns the conversion, the agent transform needs the host's brand.
 * Same single-boundary cast pattern as `toStored`.
 */
type AgentModel = NonNullable<Agent.Info["model"]>
export const asAgentModel = (ref: ModelRef): AgentModel => toHostModel(ref) as AgentModel

export const agentList = (ctx: Ctx): Effect.Effect<readonly { id: string; model?: HostModel }[], unknown> =>
  ctx.agent.list({}).pipe(
    Effect.map((out) =>
      (out.data ?? []).map((agent) => ({ id: String(agent.id), model: agent.model as HostModel | undefined })),
    ),
  )

export const fusionHost = (ctx: Ctx): FusionHostService => ({
  prompt: (input) =>
    ctx.session
      .prompt({ sessionID: input.sessionID as Session.ID, text: input.text, metadata: input.metadata })
      .pipe(Effect.map((user) => ({ id: String(user.id) }))),
  wait: (sessionID) => ctx.session.wait({ sessionID: sessionID as Session.ID }),
  context: (sessionID) =>
    ctx.session.context({ sessionID: sessionID as Session.ID }) as unknown as Effect.Effect<Transcript, unknown>,
  interrupt: (sessionID) => ctx.session.interrupt({ sessionID: sessionID as Session.ID }),
  synthetic: (input) =>
    ctx.session
      .synthetic({ sessionID: input.sessionID as Session.ID, text: input.text, resume: input.resume })
      .pipe(Effect.asVoid),
  workingDiff: () =>
    ctx.vcs.diff({ mode: "working" }).pipe(
      Effect.map((out) => (out.data ?? []) as readonly FileStat[]),
    ),
  get: (sessionID) =>
    ctx.session.get({ sessionID: sessionID as Session.ID }).pipe(
      Effect.map((session) => ({
        archived: Boolean(session.time.archived),
        model: session.model as HostModel | undefined,
      })),
    ),
  create: (input) =>
    ctx.session
      .create({
        agent: input.agent as Agent.ID,
        ...(input.model ? { model: input.model as Model.Ref } : {}),
        title: input.title,
        metadata: input.metadata,
      })
      .pipe(Effect.map((session) => ({ id: String(session.id) }))),
  switchModel: (input) =>
    ctx.session.switchModel({ sessionID: input.sessionID as Session.ID, model: input.model as Model.Ref }),
})
