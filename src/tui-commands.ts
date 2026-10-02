/**
 * Fusion's commands: their keymap metadata, and the three flows behind them.
 *
 * `/fusion` walks lead model → lead effort → sidekick model → sidekick effort
 * through the models OpenCode actually has available at this location, saves
 * the pair through the server plugin, and moves the live session onto the lead.
 * `/fusion-stats` prices this session's sidekick work against lead rates.
 * `Fusion: show current pairing` reports what is live.
 *
 * This module also owns what those flows need from the host: the catalogue
 * sync and filter, the pricing adapter, the wizard's dialog adapter, the
 * `SessionReader` assembly, the toast and alert wording, and the bindings list
 * — derived from the command ids, so a renamed command cannot keep a stale
 * binding.
 *
 * Pair consistency is RPC-event-only. A successful `setPair` does not touch
 * the status state: `status-lifecycle.ts` refreshes it when the server's
 * `pairChanged` event lands. The saved status is still used here, for
 * activation and for the success toast.
 *
 * A server plugin that cannot be reached is not a dead end for the commands:
 * `loadPair` warns and answers with the unconfigured default, so `/fusion`
 * still opens unprefilled, `/fusion-stats` still says no pair is picked yet,
 * and the pairing summary still reports the defaults.
 *
 * JSX-free with type-only `@opencode/*` imports, so tests drive the returned
 * command `run` functions on plain Node. The one JSX collaborator — the savings
 * dialog — is injected as `showSavings`.
 */
import type { ModelInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { Effect } from "effect"
import { createCosts } from "./costs.ts"
import { LEAD_AGENT, SIDEKICK_AGENT, describeModelRef, type ModelRef } from "./pair.ts"
import { createPairing, toWizardModel, type Catalogue, type Dialogs } from "./pairing.ts"
import type { FusionClient, PairStatus } from "./rpc.ts"
import { collectSavings, type SessionReader } from "./savings.ts"
import { savingsTable, type SavingsTable } from "./savings-table.ts"
import { sidekickSessions, type SidekickSession } from "./sidekick-state.ts"
import { activateLead } from "./tui-activation.ts"
import type { TuiRuntime } from "./tui-runtime.ts"

/** The claim input `claimKeymap` takes: a factory for the reactive keymap layer. */
export type KeymapLayerClaim = Parameters<Plugin.Context["keymap"]["layer"]>[0]

/** The savings dialog, injected so this module stays JSX-free. */
export type SavingsPresenter = (table: SavingsTable) => Promise<void>

/**
 * The command metadata, in palette order. Each entry names the flow it runs;
 * `slash` is absent for the command with no slash form. The layer's `bindings`
 * and its `commands` are both derived from this list, so a renamed command can
 * never keep a stale binding.
 */
const COMMANDS = [
  {
    id: "fusion.pair",
    title: "Fusion: pair lead + sidekick models",
    description: "Pick the lead and sidekick models and their effort levels",
    slash: { name: "fusion" },
    run: "pair",
  },
  {
    id: "fusion.stats",
    title: "Fusion: savings report",
    description: "This session's sidekick tokens and what they would have cost at lead rates",
    slash: { name: "fusion-stats" },
    run: "stats",
  },
  {
    id: "fusion.show",
    title: "Fusion: show current pairing",
    description: "Show the active lead/sidekick pairing",
    run: "show",
  },
] as const

const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (cause) => cause })

/** The pair the commands work from when the server plugin cannot be reached: nothing is paired yet. */
const unconfigured = (): PairStatus => ({
  configured: false,
  leadAgent: LEAD_AGENT,
  sidekickAgent: SIDEKICK_AGENT,
})

/**
 * Every flow's one read of the pair. A failure is warned about, not surfaced as
 * a dead end: the flows below all have a sensible answer for "nothing is
 * configured", so an unreachable server plugin costs the user the prefill and
 * nothing else. (`status-lifecycle.ts` keeps its own copy of the same
 * fallback for the status line.)
 */
const loadPair = (fusion: FusionClient): Effect.Effect<PairStatus> =>
  fromPromise(() => fusion.getPair()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.warn(`[fusion] server plugin unreachable: ${String(error)}`)
        return unconfigured()
      }),
    ),
  )

/** Builds Fusion's command layer: metadata, flows, and the bindings those ids imply. */
export function createFusionCommands(deps: {
  readonly context: Plugin.Context
  readonly fusion: FusionClient
  readonly runtime: TuiRuntime
  /** The host session snapshot `status-lifecycle` keeps fresh. */
  readonly sessions: () => readonly SidekickSession[]
  readonly showSavings: SavingsPresenter
}): KeymapLayerClaim {
  const { context, fusion, runtime, sessions, showSavings } = deps

  /**
   * The models OpenCode has at this location, synced first. A failed sync is
   * not fatal: the catalogue may still be warm, and an empty list is handled
   * downstream (the wizard says so, the pricing card comes back empty).
   */
  const catalogue: Effect.Effect<ModelInfo[]> = Effect.gen(function* () {
    const location = context.location ?? context.data.location.default()
    yield* fromPromise(() => context.data.location.model.sync(location)).pipe(
      Effect.catch((error) => Effect.sync(() => console.warn(`[fusion] model sync failed: ${String(error)}`))),
    )
    const list = context.data.location.model.list(location) ?? []
    const available = list.filter((model) => model.enabled !== false)
    return available.length > 0 ? available : list
  })

  const leadPricing = createCosts(() => runtime.runPromise(catalogue))

  // The dialogs and the catalogue, adapted to the wizard's structural seams.
  const dialogs: Dialogs = {
    select: (input) => runtime.runPromise(fromPromise(() => context.ui.dialog.select(input))),
    alert: (input) => runtime.runPromise(fromPromise(() => context.ui.dialog.alert(input))).then(() => undefined),
    toast: (input) => {
      if (!runtime.isDisposed()) context.ui.toast.show(input)
    },
  }
  const wizardCatalogue: Catalogue = {
    models: () => runtime.runPromise(Effect.map(catalogue, (list) => list.map(toWizardModel))),
  }
  const pickPair = createPairing({ dialogs, catalogue: wizardCatalogue })

  const readPair: Effect.Effect<PairStatus> = loadPair(fusion)

  const pairUp: Effect.Effect<void, unknown> = Effect.gen(function* () {
    // Unreachable server plugin included: the wizard still opens, unprefilled.
    const current = yield* readPair
    const picked = yield* fromPromise(() => pickPair(current.pair))
    // Undefined means the user backed out at some step; nothing to save.
    if (!picked) return
    const next = picked.pair

    const saved = yield* fromPromise(() => fusion.setPair(next)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          context.ui.toast.show({ message: `Fusion: failed to save the pair — ${String(error)}`, variant: "error" })
          return undefined
        }),
      ),
    )
    if (!saved) return
    // No status write here: the server's pairChanged event refreshes the status
    // line, and writing it too would race that refresh.

    // Follow the lead: move the live session onto the lead agent and the
    // picked lead model now.
    const activated = yield* activateLead(context, saved).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.sync(() => {
          context.ui.toast.show({
            title: "Fusion",
            message: `pair saved, but live-session activation failed — ${String(error)}`,
            variant: "warning",
          })
          return false
        }),
      ),
    )

    // The wizard returns notes rather than toasting them, so the success
    // toast stays one message composed here.
    if (activated)
      context.ui.toast.show({
        title: "Fusion paired",
        message:
          `lead ${describeModelRef(next.lead)} · sidekick ${describeModelRef(next.sidekick)}` +
          (picked.warnings.length > 0 ? ` · ${picked.warnings.join(" · ")}` : ""),
        variant: "success",
      })
  })

  /**
   * Per-session savings: the current lead session's billed cost, then every
   * sidekick session ever created for it (older ones survive `reset: true`
   * via the server's history) priced per message at lead rates.
   */
  const showStats: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const fail = (message: string) => fromPromise(() => context.ui.dialog.alert({ title: "Fusion savings", message }))
    const route = context.ui.router.current()
    if (route.type !== "session") {
      yield* fail("open a Fusion lead session first")
      return
    }
    const sessionID = route.sessionID
    const status = yield* readPair
    const snapshot = yield* fromPromise(() => {
      const reader: SessionReader = {
        sessionID,
        getSession: (id) =>
          runtime.runPromise(fromPromise(() => context.client.session.get({ sessionID: id }))),
        sidekickSessions: () =>
          runtime.runPromise(Effect.sync(() => sidekickSessions(sessions(), sessionID))),
        listAssistantMessages: (id, cursor) =>
          runtime.runPromise(
            fromPromise(() => context.client.message.list({ sessionID: id, type: "assistant", limit: 100, cursor })),
          ),
        leadPricing,
      }
      return collectSavings(status.pair, reader)
    })
    if (!snapshot) {
      yield* fail("no pair picked yet — run /fusion")
      return
    }
    yield* fromPromise(() => showSavings(savingsTable(snapshot)))
  }).pipe(
    Effect.catch((error) =>
      fromPromise(() => context.ui.dialog.alert({ title: "Fusion savings", message: `unavailable: ${String(error)}` })),
    ),
  )

  const showPairing: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const status = yield* readPair
    const selected = context.ui.model.current()
    const variants = context.ui.model.variant.list()
    const describe = (ref: ModelRef | undefined) => (ref ? describeModelRef(ref) : "not picked (OpenCode default model)")
    yield* fromPromise(() =>
      context.ui.dialog.alert({
        title: "Fusion pairing",
        message: [
          `lead     ${describe(status.pair?.lead)} → agent ${status.leadAgent}`,
          `sidekick ${describe(status.pair?.sidekick)} → agent ${status.sidekickAgent}`,
          `live model ${selected ? describeModelRef(selected) : "none"}`,
          `live variants ${variants.join(", ") || "none"}`,
          "",
          "run /fusion to change the pair",
        ].join("\n"),
      }),
    )
  })

  const flows: Record<(typeof COMMANDS)[number]["run"], () => Promise<void>> = {
    pair: () => runtime.runPromise(pairUp),
    stats: () => runtime.runPromise(showStats),
    show: () => runtime.runPromise(showPairing),
  }

  return () => ({
    mode: "global",
    priority: 10,
    commands: COMMANDS.map(({ run, ...meta }) => ({
      ...meta,
      group: "Fusion",
      palette: true as const,
      run: flows[run],
    })),
    bindings: COMMANDS.map((meta) => meta.id),
  })
}
