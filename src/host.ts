import { Context, Effect, Scheduler } from "effect"
import type { FileStat, SidekickHost, Transcript } from "./handoffs.ts"
import type { HostModel } from "./pair.ts"
import type { SessionHost } from "./sidekick-sessions.ts"
import type { SidekickStorage } from "./registry.ts"

export interface SessionView {
  readonly archived: boolean
  readonly model?: HostModel
}

export interface FusionHostService {
  prompt(input: { sessionID: string; text: string; metadata: Record<string, string> }): Effect.Effect<{ id: string }, unknown>
  wait(sessionID: string): Effect.Effect<void, unknown>
  context(sessionID: string): Effect.Effect<Transcript, unknown>
  interrupt(sessionID: string): Effect.Effect<{ interrupted?: boolean }, unknown>
  synthetic(input: { sessionID: string; text: string; resume?: boolean }): Effect.Effect<void, unknown>
  workingDiff(): Effect.Effect<readonly FileStat[], unknown>
  get(sessionID: string): Effect.Effect<SessionView | undefined, unknown>
  create(input: {
    agent: string
    model?: HostModel
    title: string
    metadata: Record<string, string>
  }): Effect.Effect<{ id: string }, unknown>
  switchModel(input: { sessionID: string; model: HostModel }): Effect.Effect<void, unknown>
}

export type EffectSidekickHost = Pick<
  FusionHostService,
  "prompt" | "wait" | "context" | "interrupt" | "synthetic" | "workingDiff"
>

export type EffectSessionHost = Pick<FusionHostService, "get" | "create" | "switchModel">

export class FusionHost extends Context.Service<FusionHost, FusionHostService>()("opencode-fusion/FusionHost") {}

export interface FusionStorageService {
  get(key: string): Effect.Effect<unknown, unknown>
  set(key: string, value: unknown): Effect.Effect<void, unknown>
}

export class FusionStorage extends Context.Service<FusionStorage, FusionStorageService>()(
  "opencode-fusion/FusionStorage",
) {}

export const facadeScheduler = new Scheduler.MixedScheduler("sync")

const fromPromise = <A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

export const promiseSidekickHost = (host: SidekickHost): EffectSidekickHost => ({
  prompt: (input) => fromPromise(() => host.prompt(input)),
  wait: (sessionID) => fromPromise((signal) => host.wait(sessionID, { signal })),
  context: (sessionID) => fromPromise(() => host.context(sessionID)),
  interrupt: (sessionID) => fromPromise(() => host.interrupt(sessionID)),
  synthetic: (input) => fromPromise(() => host.synthetic(input)),
  workingDiff: () => fromPromise(() => host.workingDiff()),
})

export const promiseSessionHost = (host: SessionHost): EffectSessionHost => ({
  get: (sessionID) => fromPromise(() => host.get(sessionID)),
  create: (input) => fromPromise(() => host.create(input)),
  switchModel: (input) => fromPromise(() => host.switchModel(input)),
})

export const promiseStorage = (storage: SidekickStorage): FusionStorageService => ({
  get: (key) => fromPromise(() => storage.get(key)),
  set: (key, value) => fromPromise(() => storage.set(key, value)),
})
