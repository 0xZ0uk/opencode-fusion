/**
 * Handoff lifecycle: start a sidekick turn, wait in the foreground with abort
 * and timeout handling, detach to the background, format the report, cancel.
 *
 * Type-only imports on purpose: no runtime dependency on `@opencode/*`. The
 * host and session registry come in as seams so this module can be driven
 * against a fake.
 */
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"
import { randomUUID } from "node:crypto"
import { Clock, Context, DateTime, Effect, Exit, Fiber, Scope } from "effect"
import { facadeScheduler, promiseSidekickHost, type EffectSidekickHost } from "./host.ts"
import type { SidekickSessionsApi } from "./sidekick-sessions.ts"


export type Transcript = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
export type StepEnded = Extract<OpenCodeEvent, { type: "session.step.ended" }>["data"]
/** Structural stand-in for the host's per-file diff stats. */
export type FileStat = { file: string; additions: number; deletions: number }

export type SidekickHost = {
  prompt(input: { sessionID: string; text: string; metadata: Record<string, string> }): Promise<{ id: string }>
  wait(sessionID: string, options?: { signal?: AbortSignal }): Promise<void>
  context(sessionID: string): Promise<Transcript>
  interrupt(sessionID: string): Promise<{ interrupted?: boolean }>
  synthetic(input: { sessionID: string; text: string; resume?: boolean }): Promise<void>
  /** ctx.vcs.diff({ mode: "working" }) mapped to FileStat[]; may throw, it is best-effort. */
  workingDiff(): Promise<readonly FileStat[]>
}

/** Registry seam: persistent sidekick-session bookkeeping, not a raw map. */
export type SidekickSessions = {
  ensure(leadSessionID: string): Promise<string>
  current(leadSessionID: string): string | undefined
  /** reset: true drops the lead's current sidekick session; awaited so its write lands before the new session is created. */
  forget(leadSessionID: string): Promise<void>
}

export type Handoffs = {
  delegate(input: {
    leadSessionID: string
    message: string
    block: boolean
    reset: boolean
    signal: AbortSignal
    progress: (update: Record<string, unknown>) => void | Promise<void>
  }): Promise<{ content: string; metadata?: Record<string, unknown> }>
  status(leadSessionID: string): string
  cancel(leadSessionID: string): Promise<string>
  onStep(sessionID: string, data: StepEnded): void
  dispose(): Promise<void>
}

export interface DelegateInput {
  leadSessionID: string
  message: string
  block: boolean
  reset: boolean
  signal?: AbortSignal
  progress(update: Record<string, unknown>): Effect.Effect<void, unknown>
}

export interface HandoffApi {
  delegate(input: DelegateInput): Effect.Effect<{ content: string; metadata?: Record<string, unknown> }, unknown>
  status(leadSessionID: string): string
  cancel(leadSessionID: string): Effect.Effect<string, unknown>
  onStep(sessionID: string, data: StepEnded): void
}

export class HandoffService extends Context.Service<HandoffService, HandoffApi>()("opencode-fusion/Handoffs") {}

/** Text of the last non-empty assistant message in `messages[from..to)`. */
function lastAssistantText(messages: Transcript, from: number, to: number): string {
  for (let index = to - 1; index >= from; index -= 1) {
    const message = messages[index]
    if (message.type !== "assistant") continue
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return ""
}

/**
 * Slice one handoff's report out of the sidekick transcript: the user message
 * carrying the handoff marker (or the prompt's inbox id) starts the slice, the
 * next user message ends it. Falls back to the last assistant text overall —
 * the pre-marker behaviour — when the marker is not in the transcript.
 */
export function handoffReport(
  messages: Transcript,
  handoffID: string,
  inboxID: string | undefined,
): { text: string; files: string[]; matched: boolean } {
  const start = messages.findIndex(
    (message) => message.type === "user" && (message.metadata?.fusionHandoff === handoffID || message.id === inboxID),
  )
  if (start < 0) return { text: lastAssistantText(messages, 0, messages.length), files: [], matched: false }
  let end = messages.length
  for (let index = start + 1; index < messages.length; index += 1) {
    if (messages[index].type === "user") {
      end = index
      break
    }
  }
  const seen = new Set<string>()
  const files: string[] = []
  for (let index = start + 1; index < end; index += 1) {
    const message = messages[index]
    if (message.type !== "assistant") continue
    for (const file of message.snapshot?.files ?? []) {
      if (seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
  }
  return { text: lastAssistantText(messages, start + 1, end), files, matched: true }
}

type Handoff = {
  sessionID: string
  inboxID?: string
  started: number
  block: boolean
  cancelled?: boolean
  fiber?: Fiber.Fiber<void, unknown>
}

const awaitAbort = (signal: AbortSignal | undefined): Effect.Effect<void> => {
  if (!signal) return Effect.never
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

export const makeHandoffs = Effect.fn("makeHandoffs")(function* (deps: {
  host: EffectSidekickHost
  sessions: SidekickSessionsApi
  blockTimeoutSeconds: number
}): Effect.fn.Return<HandoffApi, never, Scope.Scope> {
    const { host, sessions, blockTimeoutSeconds } = deps
    const scope = yield* Effect.scope

    // In-flight handoffs: lead session -> handoff id -> record. Process-local;
    // a restart loses them, which `status` says out loud. The TUI no longer
    // watches this: it derives "sidekick running" from the host's session status.
    const active = new Map<string, Map<string, Handoff>>()

    const dropHandoff = (leadSessionID: string, handoffID: string) => {
      const handoffs = active.get(leadSessionID)
      if (!handoffs) return
      handoffs.delete(handoffID)
      if (handoffs.size === 0) active.delete(leadSessionID)
    }

    // `session.step.ended` events fanned out per sidekick session, for progress.
    const stepListeners = new Map<string, Set<(data: StepEnded) => void>>()

    /**
     * Report text, then the changed-file list. Per-file +A/−D stats come from
     * the working-tree diff when the checkout offers one; the file paths stand
     * alone otherwise.
     */
    const formatReport = Effect.fn("formatReport")(function* (
      sessionID: string,
      report: { text: string; files: string[]; matched: boolean },
    ) {
        const stats = yield* host.workingDiff().pipe(
          Effect.map((diff) => new Map(diff.map((entry) => [entry.file, entry]))),
          /* per-file stats are best-effort */
          Effect.catch(() => Effect.succeed(undefined as Map<string, FileStat> | undefined)),
        )
        const lines = [report.text || "finished with no text report", ""]
        if (report.files.length === 0) {
          lines.push("Changed files: none recorded")
        } else {
          lines.push("Changed files:")
          for (const file of report.files) {
            const entry = stats?.get(file)
            lines.push(entry ? `${file} (+${entry.additions} −${entry.deletions} working tree)` : file)
          }
        }
        if (!report.matched) {
          lines.push("(report matched by recency, not by handoff — may belong to another handoff)")
        }
        lines.push("", `sidekick session: ${sessionID}`)
        return lines.join("\n")
      })

    /** Wait out a background handoff, then post the report into the lead session. */
    const finishInBackground = Effect.fn("finishInBackground")(function* (
      leadSessionID: string,
      handoffID: string,
    ) {
      const handoff = active.get(leadSessionID)?.get(handoffID)
      if (!handoff) return
      const sessionID = handoff.sessionID
      yield* Effect.gen(function* () {
        yield* host.wait(sessionID)
        if (handoff.cancelled) return
        const report = handoffReport(yield* host.context(sessionID), handoffID, handoff.inboxID)
        const text = yield* formatReport(sessionID, report)
        if (handoff.cancelled) return
        yield* host.synthetic({
          sessionID: leadSessionID,
          text: `<sidekick_report session="${sessionID}" handoff="${handoffID}">\n${text}\n</sidekick_report>`,
          resume: true,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => console.warn(`[fusion] sidekick background report failed: ${String(error)}`)),
        ),
        Effect.ensuring(Effect.sync(() => dropHandoff(leadSessionID, handoffID))),
      )
    })

    const delegate = Effect.fn("delegate")(function* (input: DelegateInput) {
      const { leadSessionID, message, block, reset, signal: leadSignal, progress } = input
      /* progress is cosmetic */
      const safeProgress = (update: Record<string, unknown>) => Effect.ignore(progress(update))
      const services = yield* Effect.context()

      if (reset) yield* sessions.forget(leadSessionID)
      const sessionID = yield* sessions.ensure(leadSessionID)
      const handoffID = randomUUID()
      const callScope = yield* Scope.make()
      const emitProgress = (update: Record<string, unknown>) => {
        Effect.runSync(
          Effect.forkIn(callScope, { startImmediately: true })(Effect.provide(safeProgress(update), services)),
        )
      }

      let removeListener: Effect.Effect<void> = Effect.void
      const region = Effect.gen(function* () {
        const inbox = yield* host.prompt({
          sessionID,
          text: message,
          metadata: { fusionHandoff: handoffID, fusionLeadSession: leadSessionID },
        })
        let handoffs = active.get(leadSessionID)
        if (!handoffs) {
          handoffs = new Map()
          active.set(leadSessionID, handoffs)
        }
        const record: Handoff = {
          sessionID,
          inboxID: String(inbox.id),
          started: yield* Clock.currentTimeMillis,
          block,
        }
        handoffs.set(handoffID, record)

        yield* safeProgress({ sessionID, title: "sidekick running", status: "running" })

        if (!block) {
          record.fiber = yield* Effect.forkIn(scope, { startImmediately: true })(
            finishInBackground(leadSessionID, handoffID),
          )
          return {
            content: `sidekick started in session ${sessionID} (handoff ${handoffID.slice(0, 8)}); its report will arrive as a follow-up message.`,
            metadata: { sessionID, handoffID },
          }
        }

        let steps = 0
        const stepFiles: string[] = []
        const onStep = (data: StepEnded) => {
          steps += 1
          for (const file of data.files ?? []) {
            if (!stepFiles.includes(file)) stepFiles.push(file)
          }
          emitProgress({
            sessionID,
            title: `sidekick · step ${steps}`,
            status: "running",
            steps,
            files: [...stepFiles],
          })
        }
        let listeners = stepListeners.get(sessionID)
        if (!listeners) {
          listeners = new Set()
          stepListeners.set(sessionID, listeners)
        }
        listeners.add(onStep)
        removeListener = Effect.sync(() => {
          listeners.delete(onStep)
          if (listeners.size === 0) stepListeners.delete(sessionID)
        })

        // The signal is also raced, not only passed: a host that ignores
        // request signals must not hang the lead's turn forever.
        const outcome = yield* Effect.raceFirst(
          Effect.as(host.wait(sessionID), "waited" as const),
          Effect.raceFirst(
            Effect.as(Effect.sleep(`${blockTimeoutSeconds} seconds`), "timeout" as const),
            Effect.as(awaitAbort(leadSignal), "aborted" as const),
          ),
        )
        if (outcome === "aborted" || leadSignal?.aborted) {
          yield* Effect.ignore(host.interrupt(sessionID))
          dropHandoff(leadSessionID, handoffID)
          return {
            content: "sidekick: cancelled — the lead's turn was aborted; the sidekick was interrupted.",
            metadata: { sessionID, handoffID },
          }
        }
        if (outcome === "timeout") {
          const handoff = handoffs.get(handoffID)
          if (handoff) handoff.block = false
          record.fiber = yield* Effect.forkIn(scope, { startImmediately: true })(
            finishInBackground(leadSessionID, handoffID),
          )
          return {
            content: `sidekick: still running after ${blockTimeoutSeconds}s; detached to the background — its report will arrive as a follow-up message. Use action "status"/"cancel" to manage it.`,
            metadata: { sessionID, handoffID },
          }
        }
        const report = handoffReport(yield* host.context(sessionID), handoffID, handoffs.get(handoffID)?.inboxID)
        const content = yield* formatReport(sessionID, report)
        dropHandoff(leadSessionID, handoffID)
        if (record.cancelled) {
          return {
            content: "sidekick: cancelled — the lead's turn was aborted; the sidekick was interrupted.",
            metadata: { sessionID, handoffID },
          }
        }
        return {
          content,
          metadata: { sessionID, handoffID, files: report.files },
        }
      }).pipe(
        Effect.onError(() => Effect.sync(() => dropHandoff(leadSessionID, handoffID))),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            /* interrupting is best-effort */
            yield* Effect.ignore(host.interrupt(sessionID))
            dropHandoff(leadSessionID, handoffID)
          }),
        ),
        Effect.ensuring(Effect.suspend(() => removeListener)),
        Effect.ensuring(Scope.close(callScope, Exit.void)),
      )
      return yield* region
    })

    const status = (leadSessionID: string): string => {
      const running = [...(active.get(leadSessionID)?.entries() ?? [])].map(
        ([id, handoff]) =>
          `${id.slice(0, 8)} · ${handoff.block ? "foreground" : "background"} · ${Math.round((DateTime.toEpochMillis(DateTime.nowUnsafe()) - handoff.started) / 1000)}s`,
      )
      return [
        running.length > 0 ? `handoffs in flight:\n${running.join("\n")}` : "no handoff in flight",
        `sidekick session: ${sessions.current(leadSessionID) ?? "none"}`,
        "(only handoffs started by this process are listed)",
      ].join("\n")
    }

    const cancel = Effect.fn("cancel")(function* (leadSessionID: string) {
      const sessionID = sessions.current(leadSessionID)
      if (!sessionID) return "sidekick: no sidekick session"
      const handoffs = [...(active.get(leadSessionID)?.entries() ?? [])]
      for (const [, handoff] of handoffs) {
        handoff.cancelled = true
        if (handoff.fiber) yield* Fiber.interrupt(handoff.fiber)
      }
      const { interrupted } = yield* host.interrupt(sessionID)
      return (
        `sidekick: cancelled ${handoffs.length > 0 ? handoffs.map(([id]) => id.slice(0, 8)).join(", ") : "nothing in flight"}` +
        ` (interrupted=${interrupted})`
      )
    })

    const onStep = (sessionID: string, data: StepEnded): void => {
      const listeners = stepListeners.get(sessionID)
      if (listeners) for (const listener of listeners) listener(data)
    }

    return { delegate, status, cancel, onStep }
  })

export function createHandoffs(deps: {
  host: SidekickHost
  sessions: SidekickSessions
  blockTimeoutSeconds: number
}): Handoffs {
  const { host, sessions } = deps
  const scope = Effect.runSync(Scope.make())
  const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
    Effect.tryPromise({ try: run, catch: (cause) => cause })
  const fxSessions: SidekickSessionsApi = {
    ensure: (leadSessionID) => fromPromise(() => sessions.ensure(leadSessionID)),
    current: (leadSessionID) => sessions.current(leadSessionID),
    forget: (leadSessionID) => fromPromise(() => sessions.forget(leadSessionID)),
  }
  const service = Effect.runSync(
    Effect.provideService(
      makeHandoffs({
        host: promiseSidekickHost(host),
        sessions: fxSessions,
        blockTimeoutSeconds: deps.blockTimeoutSeconds,
      }),
      Scope.Scope,
      scope,
    ),
  )
  return {
    delegate: (input) =>
      Effect.runPromise(
        service.delegate({
          leadSessionID: input.leadSessionID,
          message: input.message,
          block: input.block,
          reset: input.reset,
          signal: input.signal,
          progress: (update) => fromPromise(() => Promise.resolve(input.progress(update))),
        }),
        { scheduler: facadeScheduler },
      ),
    status: (leadSessionID) => service.status(leadSessionID),
    cancel: (leadSessionID) => Effect.runPromise(service.cancel(leadSessionID), { scheduler: facadeScheduler }),
    onStep: (sessionID, data) => service.onStep(sessionID, data),
    dispose: () => Effect.runPromise(Scope.close(scope, Exit.void), { scheduler: facadeScheduler }),
  }
}
