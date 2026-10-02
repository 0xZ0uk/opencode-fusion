/**
 * TUI half of Fusion: V2 setup and cleanup, plus the two JSX claims.
 *
 * Everything with behaviour lives in `status-lifecycle.ts` (the prompt-footer
 * status line) and `tui-commands.ts` (`/fusion`, `/fusion-stats`, and the
 * pairing summary). This file only builds the runtime and the RPC client,
 * warns on an untested OpenCode version, and hands the two claims their
 * inputs.
 *
 * `prompt.footer.status` is claimed here rather than in the lifecycle so the
 * slot's disposer joins the runtime's release list alongside the lifecycle's
 * own; `context.keymap.layer` is claimed through a component in
 * `keymap.tsx` because the host only publishes its providers inside its tree.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { Fusion, fusionClient } from "./rpc.ts"
import { startStatusLifecycle } from "./status-lifecycle.ts"
import { claimStatus } from "./status.tsx"
import { createFusionCommands } from "./tui-commands.ts"
import { showSavingsDialog } from "./savings-dialog.tsx"
import { versionWarning } from "./version.ts"
import { claimKeymap } from "./keymap.tsx"
import { withTuiRuntime } from "./tui-runtime.ts"

const plugin: Plugin.Definition = {
  id: "opencode-fusion.tui",
  async setup(context) {
    return withTuiRuntime((runtime) => {
      const fusion = fusionClient(context.client.rpc(Fusion))

      const warning = versionWarning(context.app?.version)
      if (warning) context.ui.toast.show({ title: "Fusion", message: warning, variant: "warning" })

      const status = startStatusLifecycle({ context, fusion, runtime })
      runtime.register(status, (started) => started.dispose())
      runtime.register(claimStatus(context, status.claim), (dispose) => dispose())

      runtime.register(
        claimKeymap(
          context,
          createFusionCommands({
            context,
            fusion,
            runtime,
            sessions: status.claim.sessions,
            showSavings: (table) => showSavingsDialog(context, table),
          }),
        ),
        (dispose) => dispose(),
      )
    })
  },
}

export default plugin
