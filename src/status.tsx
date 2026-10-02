/** @jsxImportSource @opentui/solid */

/**
 * The prompt-footer status slot: shows the active pair on lead sessions, and
 * whether a sidekick handoff is running. The host provides `@opentui/solid`
 * and `solid-js` at runtime.
 *
 * Wiring only. The state it renders and the host snapshot behind it are owned
 * by `status-lifecycle.ts`; the sentence's predicate and text live in
 * `statusline.ts`.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { sidekickRunning, type SidekickSession } from "./sidekick-state.ts"
import type { StatusClaim, StatusLineStore } from "./status-lifecycle.ts"
import { isLeadSession, statusText } from "./statusline.ts"

function FusionStatus(props: {
  context: Plugin.Context
  state: StatusLineStore
  sessions: () => readonly SidekickSession[]
  sessionID: string | undefined
}) {
  const leadSession = () => {
    void props.state.sessionsVersion
    const session = props.sessionID ? props.context.data.session.get(props.sessionID) : undefined
    return isLeadSession(props.state, props.sessionID, session?.agent)
  }
  const text = () => {
    // Read the revision so the sentence re-derives when the host's sessions change.
    void props.state.sessionsVersion
    const running =
      props.sessionID !== undefined && sidekickRunning(props.sessions(), props.sessionID)
    return statusText(props.state, props.sessionID, running, props.context.ui.model.current())
  }
  return (
    <Show when={leadSession()}>
      <text fg={props.context.theme.text.muted}>{text()}</text>
    </Show>
  )
}

/** Claims `prompt.footer.status`; returns the slot disposer. */
export function claimStatus(context: Plugin.Context, claim: StatusClaim): () => void {
  return context.ui.slot({
    append: "prompt.footer.status",
    render: (input) => (
      <FusionStatus context={context} state={claim.state} sessions={claim.sessions} sessionID={input.sessionID} />
    ),
  })
}
