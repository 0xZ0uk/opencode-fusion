/** @jsxImportSource @opentui/solid */

/**
 * The prompt-footer status slot: shows the active pair on lead sessions, and
 * whether a sidekick handoff is running. The host provides `@opentui/solid`
 * and `solid-js` at runtime.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { describeModelName, type FusionPair } from "./pair.ts"
import { sidekickRunning, type SidekickSession } from "./sidekick-state.ts"

export type FusionStatusState = {
  pair: FusionPair | undefined
  leadAgent: string
  /**
   * Bumped by the TUI plugin on every session event. `data.session.*` is not a
   * reactive read, so this is what pulls a fresh host snapshot into the render.
   */
  sessionsVersion: number
}

export type FusionStatusDeps = {
  readonly state: FusionStatusState
  /** The host's sessions in the shape the sidekick-state derivation reads. */
  readonly sessions: () => readonly SidekickSession[]
}

function FusionStatus(props: {
  context: Plugin.Context
  state: FusionStatusState
  sessions: () => readonly SidekickSession[]
  sessionID: string | undefined
}) {
  const leadSession = () =>
    Boolean(props.sessionID) && props.context.data.session.get(props.sessionID as string)?.agent === props.state.leadAgent
  const text = () => {
    const pair = props.state.pair
    if (!pair) return "fusion · no pair (run /fusion)"
    // Read the revision so the sentence re-derives when the host's sessions change.
    void props.state.sessionsVersion
    const running =
      props.sessionID && sidekickRunning(props.sessions(), props.sessionID) ? " · sidekick running" : ""
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
      <FusionStatus context={context} state={deps.state} sessions={deps.sessions} sessionID={input.sessionID} />
    ),
  })
}
