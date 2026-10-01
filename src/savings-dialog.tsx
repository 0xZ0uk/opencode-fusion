/** @jsxImportSource @opentui/solid */

import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { SavingsTable } from "./savings-table.ts"

const METRIC_WIDTH = 18
const LABEL_WIDTH = 24
const MODEL_LABEL_WIDTH = 8

function SavingsDialog(props: { context: Plugin.Context; table: SavingsTable; close: () => void }) {
  const theme = () => props.context.theme
  onMount(() => props.context.ui.dialog.set({ size: "large" }))

  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        title: "Close savings report",
        bind: "enter",
        run: () => props.close(),
      },
    ],
  }))

  const dimensions = useTerminalDimensions()
  const maxHeight = () => Math.max(1, dimensions().height - 10)

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base}>
          <strong>Fusion savings</strong>
        </text>
        <text fg={theme().text.muted}>esc to close</text>
      </box>

      <scrollbox maxHeight={maxHeight()} scrollX={false} focused>
        <box flexDirection="column" marginTop={1}>
          <For each={props.table.models}>
            {(model) => (
              <box flexDirection="row" columnGap={1}>
                <text width={MODEL_LABEL_WIDTH} flexShrink={0} fg={theme().text.muted}>
                  {model.label}
                </text>
                <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="word" fg={theme().text.base}>
                  {model.value}
                </text>
              </box>
            )}
          </For>

          <box flexDirection="column" marginTop={1}>
            <box flexDirection="row" columnGap={2}>
              <text width={METRIC_WIDTH} flexShrink={0} fg={theme().text.base}>
                <strong>Metric</strong>
              </text>
              <text flexGrow={1} flexBasis={0} minWidth={0} textAlign="right" wrapMode="char" fg={theme().text.base}>
                <strong>Lead</strong>
              </text>
              <text flexGrow={1} flexBasis={0} minWidth={0} textAlign="right" wrapMode="char" fg={theme().text.base}>
                <strong>Sidekick</strong>
              </text>
            </box>
            <For each={props.table.usage}>
              {(row) => (
                <box flexDirection="row" columnGap={2}>
                  <text width={METRIC_WIDTH} flexShrink={0} fg={theme().text.muted}>
                    {row.label}
                  </text>
                  <text flexGrow={1} flexBasis={0} minWidth={0} textAlign="right" wrapMode="char" fg={theme().text.base}>
                    {row.lead}
                  </text>
                  <text flexGrow={1} flexBasis={0} minWidth={0} textAlign="right" wrapMode="char" fg={theme().text.base}>
                    {row.sidekick}
                  </text>
                </box>
              )}
            </For>
          </box>

          <box flexDirection="column" marginTop={1}>
            <For each={props.table.summary}>
              {(row) => (
                <box flexDirection="row" columnGap={2}>
                  <text width={LABEL_WIDTH} flexShrink={0} fg={theme().text.muted}>
                    {row.label}
                  </text>
                  <text
                    flexGrow={1}
                    flexBasis={0}
                    minWidth={0}
                    textAlign="right"
                    wrapMode="char"
                    fg={row.highlight ? theme().text.feedback.success.base : theme().text.base}
                  >
                    {row.highlight || row.label === "Total billed" ? <strong>{row.value}</strong> : row.value}
                  </text>
                </box>
              )}
            </For>
          </box>

          <Show when={props.table.notes.length > 0}>
            <box flexDirection="column" marginTop={1}>
              <For each={props.table.notes}>
                {(note) => (
                  <text fg={theme().text.muted} wrapMode="word">
                    {note}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </scrollbox>

      <box flexDirection="row" marginTop={1} justifyContent="flex-end">
        <text fg={theme().text.action.primary.base} onMouseDown={() => props.close()}>
          <strong>[ ok ]</strong>
        </text>
      </box>
    </box>
  )
}

export function showSavingsDialog(context: Plugin.Context, table: SavingsTable): Promise<void> {
  return new Promise((resolve) => {
    context.ui.dialog.show(
      () => <SavingsDialog context={context} table={table} close={() => context.ui.dialog.clear()} />,
      () => resolve(),
    )
  })
}
