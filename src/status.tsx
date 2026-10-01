/** @jsxImportSource @opentui/solid */

/**
 * The prompt-footer status slot: shows the active pair on lead sessions, and
 * whether a sidekick handoff is running. The host provides `@opentui/solid`
 * and `solid-js` at runtime.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { Show, createEffect, on } from "solid-js"
import { describeModelName, type FusionPair } from "./pair.ts"

export type FusionStatusState = {
  pair: FusionPair | undefined
  leadAgent: string
  /** lead session id -> whether a handoff is in flight */
  running: Record<string, boolean>
}

export type FusionStatusDeps = {
  readonly state: FusionStatusState
  readonly refreshRunning: (sessionID: string) => void
}

function FusionStatus(props: {
  context: Plugin.Context
  state: FusionStatusState
  refreshRunning: (sessionID: string) => void
  sessionID: string | undefined
}) {
  // Re-check the running flag when this claim mounts or the session changes.
  createEffect(
    on(
      () => props.sessionID,
      (sessionID) => {
        if (sessionID) props.refreshRunning(sessionID)
      },
    ),
  )
  const leadSession = () =>
    Boolean(props.sessionID) && props.context.data.session.get(props.sessionID as string)?.agent === props.state.leadAgent
  const text = () => {
    const pair = props.state.pair
    if (!pair) return "fusion · no pair (run /fusion)"
    const running = props.sessionID && props.state.running[props.sessionID] ? " · sidekick running" : ""
    return `fusion ${describeModelName(pair.lead)} → ${describeModelName(pair.sidekick)}${running}`
  }
  return (
    <Show when={leadSession()}>
      <text fg={props.context.theme.text.muted}>{text()}</text>
    </Show>
  )
}

/** Claims `prompt.footer.status`; returns the slot disposer. */
export function claimStatus(context: Plugin.Context, deps: FusionStatusDeps): () => void {
  return context.ui.slot({
    append: "prompt.footer.status",
    render: (input) => (
      <FusionStatus context={context} state={deps.state} refreshRunning={deps.refreshRunning} sessionID={input.sessionID} />
    ),
  })
}
