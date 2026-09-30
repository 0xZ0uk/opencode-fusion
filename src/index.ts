/**
 * Entry point for the server-side plugin.
 *
 * OpenCode loads a plugin *directory* that contains `index.ts`, so this file
 * exists to make `src/` itself droppable:
 *
 *   cp -r src ~/.config/opencode/plugins/fusion
 *
 * The TUI half is configured separately, in cli.json.
 */
export { default } from "./server.ts"
