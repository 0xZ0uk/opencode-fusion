/** @jsxImportSource @opentui/solid */

/**
 * The plugin's keymap layer.
 *
 * `context.keymap.layer` reads Solid contexts the host only publishes inside its
 * component tree, so calling it straight from `setup` throws
 * "Keymap.Provider is missing" and the whole TUI plugin fails to load. The layer
 * is registered from a component rendered through the `app` slot instead — the
 * same shape OpenCode's own plugins use — which also scopes the layer to that
 * component's lifetime, so the host unregisters it on cleanup.
 */
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayerClaim } from "./tui-commands.ts"

/** The reactive layer `context.keymap.layer` expects. */
export type FusionKeymapLayer = KeymapLayerClaim

function FusionKeymap(props: { context: Plugin.Context; layer: FusionKeymapLayer }) {
  props.context.keymap.layer(props.layer)
  return null
}

/** Claims a component that registers `layer`; returns the slot disposer. */
export function claimKeymap(context: Plugin.Context, layer: FusionKeymapLayer): () => void {
  return context.ui.slot({
    append: "app",
    render: () => <FusionKeymap context={context} layer={layer} />,
  })
}
