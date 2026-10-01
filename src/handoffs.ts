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

export type HandoffChanged = { leadSessionID: string; sidekickSessionID: string; running: boolean }

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
  running(leadSessionID: string): boolean
  onStep(sessionID: string, data: StepEnded): void
  setEmitter(emit: ((event: HandoffChanged) => void) | undefined): void
}

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

export function createHandoffs(deps: {
  host: SidekickHost
  sessions: SidekickSessions
  blockTimeoutSeconds: number
}): Handoffs {
  const { host, sessions, blockTimeoutSeconds } = deps

  // In-flight handoffs: lead session -> handoff id -> record. Process-local;
  // a restart loses them, which `status` says out loud.
  type Handoff = { sessionID: string; inboxID?: string; started: number; block: boolean; cancelled?: boolean }
  const active = new Map<string, Map<string, Handoff>>()

  // Assigned once the RPC registration lands; a no-op before that.
  let emitHandoff: ((event: HandoffChanged) => void) | undefined

  const emit = (leadSessionID: string, sidekickSessionID: string, running: boolean) => {
    emitHandoff?.({ leadSessionID, sidekickSessionID, running })
  }

  const dropHandoff = (leadSessionID: string, handoffID: string) => {
    const handoffs = active.get(leadSessionID)
    if (!handoffs) return
    const sidekickSessionID = handoffs.get(handoffID)?.sessionID
    handoffs.delete(handoffID)
    if (handoffs.size === 0) active.delete(leadSessionID)
    if (sidekickSessionID) emit(leadSessionID, sidekickSessionID, handoffs.size > 0)
  }

  // `session.step.ended` events fanned out per sidekick session, for progress.
  const stepListeners = new Map<string, Set<(data: StepEnded) => void>>()

  /**
   * Report text, then the changed-file list. Per-file +A/−D stats come from
   * the working-tree diff when the checkout offers one; the file paths stand
   * alone otherwise.
   */
  const formatReport = async (
    sessionID: string,
    report: { text: string; files: string[]; matched: boolean },
  ): Promise<string> => {
    let stats: Map<string, FileStat> | undefined
    try {
      const diff = await host.workingDiff()
      stats = new Map(diff.map((entry) => [entry.file, entry]))
    } catch {
      /* per-file stats are best-effort */
    }
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
  }

  /** Wait out a background handoff, then post the report into the lead session. */
  const finishInBackground = (leadSessionID: string, handoffID: string) => {
    const handoff = active.get(leadSessionID)?.get(handoffID)
    if (!handoff) return
    const sessionID = handoff.sessionID
    void (async () => {
      try {
        await host.wait(sessionID)
        if (handoff.cancelled) return
        const report = handoffReport(await host.context(sessionID), handoffID, handoff.inboxID)
        const text = await formatReport(sessionID, report)
        await host.synthetic({
          sessionID: leadSessionID,
          text: `<sidekick_report session="${sessionID}" handoff="${handoffID}">\n${text}\n</sidekick_report>`,
          resume: true,
        })
      } catch (error) {
        console.warn(`[fusion] sidekick background report failed: ${String(error)}`)
      } finally {
        dropHandoff(leadSessionID, handoffID)
      }
    })()
  }

  const delegate: Handoffs["delegate"] = async (input) => {
    const { leadSessionID, message, block, reset, signal: leadSignal, progress } = input
    const safeProgress = async (update: Record<string, unknown>) => {
      try {
        await progress(update)
      } catch {
        /* progress is cosmetic */
      }
    }

    if (reset) await sessions.forget(leadSessionID)
    const sessionID = await sessions.ensure(leadSessionID)
    const handoffID = randomUUID()
    const inbox = await host.prompt({
      sessionID,
      text: message,
      metadata: { fusionHandoff: handoffID, fusionLeadSession: leadSessionID },
    })
    let handoffs = active.get(leadSessionID)
    if (!handoffs) {
      handoffs = new Map()
      active.set(leadSessionID, handoffs)
    }
    handoffs.set(handoffID, { sessionID, inboxID: String(inbox.id), started: Date.now(), block })
    emit(leadSessionID, sessionID, true)

    await safeProgress({ sessionID, title: "sidekick running", status: "running" })

    if (!block) {
      finishInBackground(leadSessionID, handoffID)
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
      void safeProgress({
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
    try {
      const signal = AbortSignal.any([leadSignal, AbortSignal.timeout(blockTimeoutSeconds * 1000)])
      const tripped = new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      let done = false
      try {
        // The signal is also raced, not only passed: a host that ignores
        // request signals must not hang the lead's turn forever.
        await Promise.race([
          host.wait(sessionID, { signal }).then(() => {
            done = true
          }),
          tripped,
        ])
      } catch (error) {
        if (!signal.aborted) throw error
      }
      if (leadSignal.aborted) {
        try {
          await host.interrupt(sessionID)
        } catch {
          /* interrupting is best-effort */
        }
        dropHandoff(leadSessionID, handoffID)
        return {
          content: "sidekick: cancelled — the lead's turn was aborted; the sidekick was interrupted.",
          metadata: { sessionID, handoffID },
        }
      }
      if (!done) {
        const handoff = handoffs.get(handoffID)
        if (handoff) handoff.block = false
        finishInBackground(leadSessionID, handoffID)
        return {
          content: `sidekick: still running after ${blockTimeoutSeconds}s; detached to the background — its report will arrive as a follow-up message. Use action "status"/"cancel" to manage it.`,
          metadata: { sessionID, handoffID },
        }
      }
      const report = handoffReport(await host.context(sessionID), handoffID, handoffs.get(handoffID)?.inboxID)
      dropHandoff(leadSessionID, handoffID)
      return {
        content: await formatReport(sessionID, report),
        metadata: { sessionID, handoffID, files: report.files },
      }
    } finally {
      listeners.delete(onStep)
      if (listeners.size === 0) stepListeners.delete(sessionID)
    }
  }

  const status = (leadSessionID: string): string => {
    const running = [...(active.get(leadSessionID)?.entries() ?? [])].map(
      ([id, handoff]) =>
        `${id.slice(0, 8)} · ${handoff.block ? "foreground" : "background"} · ${Math.round((Date.now() - handoff.started) / 1000)}s`,
    )
    return [
      running.length > 0 ? `handoffs in flight:\n${running.join("\n")}` : "no handoff in flight",
      `sidekick session: ${sessions.current(leadSessionID) ?? "none"}`,
      "(only handoffs started by this process are listed)",
    ].join("\n")
  }

  const cancel = async (leadSessionID: string): Promise<string> => {
    const sessionID = sessions.current(leadSessionID)
    if (!sessionID) return "sidekick: no sidekick session"
    const handoffs = [...(active.get(leadSessionID)?.entries() ?? [])]
    for (const [, handoff] of handoffs) handoff.cancelled = true
    const { interrupted } = await host.interrupt(sessionID)
    return (
      `sidekick: cancelled ${handoffs.length > 0 ? handoffs.map(([id]) => id.slice(0, 8)).join(", ") : "nothing in flight"}` +
      ` (interrupted=${interrupted})`
    )
  }

  const running = (leadSessionID: string): boolean => (active.get(leadSessionID)?.size ?? 0) > 0

  const onStep = (sessionID: string, data: StepEnded): void => {
    const listeners = stepListeners.get(sessionID)
    if (listeners) for (const listener of listeners) listener(data)
  }

  const setEmitter = (emit: ((event: HandoffChanged) => void) | undefined): void => {
    emitHandoff = emit
  }

  return { delegate, status, cancel, running, onStep, setEmitter }
}
