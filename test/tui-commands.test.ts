import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ModelCost, ModelInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createFusionCommands, type KeymapLayerClaim } from "../src/tui-commands.ts"
import { createTuiRuntime, type TuiRuntime } from "../src/tui-runtime.ts"
import type { FusionClient, PairStatus } from "../src/rpc.ts"
import type { ModelRef } from "../src/pair.ts"
import type { SavingsTable } from "../src/savings-table.ts"
import type { SidekickSession } from "../src/sidekick-state.ts"
import type { ActivationRoute } from "../src/tui-activation.ts"

const LEAD_COST: ModelCost[] = [{ input: 10, output: 20, cache: { read: 1, write: 5 } }]

/** Two models of one family, so a picked pair carries the same-family warning. */
const MODELS = [
  { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5", cost: LEAD_COST },
  { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5" },
] as ModelInfo[]

const SAVED_PAIR = {
  lead: { providerID: "anthropic", modelID: "claude-opus-5-5" },
  sidekick: { providerID: "anthropic", modelID: "claude-sonnet-5" },
}

const SAVED: PairStatus = {
  configured: true,
  pair: { ...SAVED_PAIR, leadAgent: "fusion", sidekickAgent: "sidekick" },
  leadAgent: "fusion",
  sidekickAgent: "sidekick",
}

type SelectCall = { title: string; options: { value: string; disabled?: boolean }[]; current?: string }
type ToastCall = { title?: string; message: string; variant?: string }

type FakeOptions = {
  route?: ActivationRoute
  pair?: PairStatus
  /** Makes `getPair` reject, as an unreachable server plugin does. */
  failRead?: boolean
  selects?: string[]
  failSave?: boolean
  failActivation?: boolean
  sessions?: readonly SidekickSession[]
  sessionCosts?: Record<string, { cost: number; tokens?: unknown }>
  messagePages?: Record<string, { data: unknown[]; cursor?: { next?: string | null } }>
  location?: { directory: string }
  /** Overrides the catalogue the wizard walks; use models with variants to see prefill. */
  models?: ModelInfo[]
}

/** A structural `Plugin.Context` covering only what the three flows reach. */
function fakeContext(options: FakeOptions = {}) {
  const selects: SelectCall[] = []
  const answers = [...(options.selects ?? [])]
  const alerts: { title: string; message: string }[] = []
  const toasts: ToastCall[] = []
  const activation: string[] = []
  const saves: { lead: ModelRef; sidekick: ModelRef }[] = []
  const memoryCalls: string[] = []
  const costs = options.sessionCosts ?? { ses_lead: { cost: 1, tokens: { input: 1000, output: 500 } } }
  // One page per session, with no next cursor: the reader stops after it.
  const pages = options.messagePages ?? {
    ses_kick: { data: [{ type: "assistant", tokens: { input: 4000, output: 2000 } }], cursor: { next: null } },
  }
  const route = options.route ?? { type: "session", sessionID: "ses_lead" }
  const pair = options.pair ?? SAVED

  const context = {
    location: options.location,
    storage: {
      // Recorded rather than served: the commands must never touch status state.
      memory: (key: string) => {
        memoryCalls.push(key)
        throw new Error(`unexpected status state access: ${key}`)
      },
    },
    client: {
      session: {
        get: async (input: { sessionID: string }) => {
          const found = costs[input.sessionID]
          if (!found) throw new Error(`no session ${input.sessionID}`)
          return found
        },
        create: async () => {
          activation.push("create")
          return { id: "ses_new" }
        },
        switchAgent: async (input: { sessionID: string; agent: string }) => {
          activation.push(`switchAgent:${input.sessionID}:${input.agent}`)
          if (options.failActivation) throw new Error("switchAgent refused")
        },
        switchModel: async (input: { sessionID: string; model: { id: string } }) => {
          activation.push(`switchModel:${input.sessionID}:${input.model.id}`)
        },
      },
      message: {
        list: async (input: { sessionID: string }) => {
          const page = pages[input.sessionID]
          if (!page) throw new Error(`no messages for ${input.sessionID}`)
          return page
        },
      },
    },
    data: {
      session: {
        sync: async (sessionID: string) => void activation.push(`sync:${sessionID}`),
      },
      location: {
        default: () => ({ directory: "/default-loc" }),
        model: {
          sync: async () => {},
          list: () => options.models ?? MODELS,
        },
      },
    },
    ui: {
      dialog: {
        select: async (input: SelectCall) => {
          selects.push(input)
          return answers.shift()
        },
        alert: async (input: { title: string; message: string }) => void alerts.push(input),
      },
      toast: { show: (input: ToastCall) => void toasts.push(input) },
      router: {
        current: () => route,
        navigate: (destination: { sessionID: string }) => void activation.push(`navigate:${destination.sessionID}`),
      },
      model: {
        current: () => ({ providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" }),
        variant: { list: () => ["high", "max"] },
      },
    },
  } as unknown as Plugin.Context

  const fusion: FusionClient = {
    getPair: async () => {
      if (options.failRead) throw new Error("connection refused")
      return pair
    },
    setPair: async (input) => {
      if (options.failSave) throw new Error("setPair refused")
      saves.push(input)
      return SAVED
    },
    apply: async () => ({ applied: true }),
    events: { on: () => () => {} },
  }

  return { context, fusion, selects, alerts, toasts, activation, saves, memoryCalls }
}

/** Drives the layer the way the host's keymap does: read it, run a command by id. */
function harness(options: FakeOptions = {}) {
  const host = fakeContext(options)
  const shown: SavingsTable[] = []
  const runtime: TuiRuntime = createTuiRuntime()
  const layer: KeymapLayerClaim = createFusionCommands({
    context: host.context,
    fusion: host.fusion,
    runtime,
    sessions: () => options.sessions ?? [],
    showSavings: async (table) => void shown.push(table),
  })
  const command = (id: string) => {
    const found = layer().commands?.find((entry) => entry.id === id)
    assert.ok(found, `no command ${id}`)
    return found
  }
  return {
    ...host,
    layer,
    command,
    shown,
    stop: () => runtime.dispose(),
  }
}

const pairWalk = (): string[] => [
  "Custom",
  "anthropic|claude-opus-5-5",
  "anthropic|claude-sonnet-5",
]

/** Catalogue with effort levels, so a prefillable select is distinguishable from a blind one. */
const EFFORT_MODELS = [
  { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5", cost: LEAD_COST, variants: [{ id: "high" }] },
  { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", variants: [{ id: "high" }] },
] as ModelInfo[]

/** Preset, lead model, lead effort, sidekick model, sidekick effort. */
const effortWalk = (): string[] => ["Custom", "anthropic|claude-opus-5-5", "high", "anthropic|claude-sonnet-5", "high"]

/**
 * Runs `body` with `console.warn` captured, and always puts the real one back:
 * the fallback warns, and a stub left installed would silence every later
 * warning in this process.
 */
async function withWarnings<T>(body: (warnings: string[]) => Promise<T>): Promise<T> {
  const warnings: string[] = []
  const real = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "))
  try {
    return await body(warnings)
  } finally {
    console.warn = real
  }
}

describe("fusion command layer metadata", () => {
  it("exposes the three commands in the palette with their slash names", async () => {
    const h = harness()
    try {
      const commands = h.layer().commands ?? []
      assert.deepEqual(
        commands.map((entry) => [entry.id, entry.title, entry.group, entry.palette, entry.slash?.name]),
        [
          ["fusion.pair", "Fusion: pair lead + sidekick models", "Fusion", true, "fusion"],
          ["fusion.stats", "Fusion: savings report", "Fusion", true, "fusion-stats"],
          ["fusion.show", "Fusion: show current pairing", "Fusion", true, undefined],
        ],
      )
      assert.equal(commands[0].description, "Pick the lead and sidekick models and their effort levels")
      assert.equal(h.layer().mode, "global")
    } finally {
      await h.stop()
    }
  })

  it("derives the bindings from the command ids", async () => {
    const h = harness()
    try {
      const layer = h.layer()
      assert.deepEqual(layer.bindings, (layer.commands ?? []).map((entry) => entry.id))
      assert.deepEqual(layer.bindings, ["fusion.pair", "fusion.stats", "fusion.show"])
    } finally {
      await h.stop()
    }
  })
})

describe("/fusion", () => {
  it("saves nothing when the wizard is cancelled", async () => {
    const h = harness({ selects: [] })
    try {
      await h.command("fusion.pair").run()
      assert.equal(h.selects.length, 1, "only the preset step ran")
      assert.deepEqual(h.saves, [])
      assert.deepEqual(h.activation, [])
      assert.deepEqual(h.toasts, [])
    } finally {
      await h.stop()
    }
  })

  it("stops before activation when the save fails", async () => {
    const h = harness({ selects: pairWalk(), failSave: true })
    try {
      await h.command("fusion.pair").run()
      assert.deepEqual(h.saves, [])
      assert.deepEqual(h.activation, [], "no live-session activation after a failed save")
      assert.equal(h.toasts.length, 1)
      assert.equal(h.toasts[0].variant, "error")
      assert.match(h.toasts[0].message, /failed to save the pair — Error: setPair refused/)
    } finally {
      await h.stop()
    }
  })

  it("saves, activates the lead and toasts the warnings without touching status state", async () => {
    const h = harness({ selects: pairWalk() })
    try {
      await h.command("fusion.pair").run()
      assert.deepEqual(h.saves, [SAVED_PAIR])
      assert.deepEqual(h.activation, [
        "switchAgent:ses_lead:fusion",
        "switchModel:ses_lead:claude-opus-5-5",
        "sync:ses_lead",
      ])
      assert.equal(h.toasts.length, 1)
      assert.equal(h.toasts[0].title, "Fusion paired")
      assert.equal(h.toasts[0].variant, "success")
      assert.match(h.toasts[0].message, /lead anthropic\/claude-opus-5-5 · sidekick anthropic\/claude-sonnet-5/)
      assert.match(h.toasts[0].message, /same family \(anthropic\): no independent cross-vendor review/)
      assert.deepEqual(h.memoryCalls, [], "pair consistency is left to the pairChanged event")
    } finally {
      await h.stop()
    }
  })

  it("warns that the pair saved but activation failed", async () => {
    const h = harness({ selects: pairWalk(), failActivation: true })
    try {
      await h.command("fusion.pair").run()
      assert.equal(h.saves.length, 1)
      assert.deepEqual(h.activation, ["switchAgent:ses_lead:fusion"])
      assert.equal(h.toasts.length, 1)
      assert.equal(h.toasts[0].variant, "warning")
      assert.match(h.toasts[0].message, /pair saved, but live-session activation failed/)
    } finally {
      await h.stop()
    }
  })
})

describe("/fusion-stats", () => {
  it("asks for a lead session when the route is not one", async () => {
    const h = harness({ route: { type: "home" } })
    try {
      await h.command("fusion.stats").run()
      assert.deepEqual(h.alerts, [{ title: "Fusion savings", message: "open a Fusion lead session first" }])
      assert.deepEqual(h.shown, [])
    } finally {
      await h.stop()
    }
  })

  it("says so when no pair is picked yet", async () => {
    const h = harness({ pair: { configured: false, leadAgent: "fusion", sidekickAgent: "sidekick" } })
    try {
      await h.command("fusion.stats").run()
      assert.deepEqual(h.alerts, [{ title: "Fusion savings", message: "no pair picked yet — run /fusion" }])
      assert.deepEqual(h.shown, [])
    } finally {
      await h.stop()
    }
  })

  it("presents the savings table for the live session and its sidekicks", async () => {
    const h = harness({
      sessions: [
        { id: "ses_lead", status: "idle" },
        { id: "ses_kick", metadata: { fusionLeadSession: "ses_lead" }, status: "running" },
      ],
      sessionCosts: {
        ses_lead: { cost: 1, tokens: { input: 1000, output: 500 } },
        ses_kick: { cost: 0.1, tokens: { input: 4000, output: 2000 } },
      },
    })
    try {
      await h.command("fusion.stats").run()
      assert.deepEqual(h.alerts, [])
      assert.equal(h.shown.length, 1)
      const table = h.shown[0]
      assert.deepEqual(table.models, [
        { label: "Lead", value: "anthropic/claude-opus-5-5" },
        { label: "Sidekick", value: "anthropic/claude-sonnet-5" },
      ])
      assert.deepEqual(
        table.usage.find((row) => row.label === "Sessions"),
        { label: "Sessions", lead: "1", sidekick: "1" },
      )
      assert.ok(table.notes.some((note) => note.includes("OpenCode catalogue")))
    } finally {
      await h.stop()
    }
  })
})

describe("show pairing", () => {
  it("names the saved pair, the agents and the live selection", async () => {
    const h = harness()
    try {
      await h.command("fusion.show").run()
      assert.equal(h.alerts.length, 1)
      assert.equal(h.alerts[0].title, "Fusion pairing")
      assert.deepEqual(h.alerts[0].message.split("\n"), [
        "lead     anthropic/claude-opus-5-5 → agent fusion",
        "sidekick anthropic/claude-sonnet-5 → agent sidekick",
        "live model openai/gpt-5.6-sol#high",
        "live variants high, max",
        "",
        "run /fusion to change the pair",
      ])
    } finally {
      await h.stop()
    }
  })

  it("says nothing is picked when the server has no pair", async () => {
    const h = harness({ pair: { configured: false, leadAgent: "fusion", sidekickAgent: "sidekick" } })
    try {
      await h.command("fusion.show").run()
      assert.match(h.alerts[0].message, /lead {5}not picked \(OpenCode default model\)/)
      assert.match(h.alerts[0].message, /sidekick not picked \(OpenCode default model\)/)
    } finally {
      await h.stop()
    }
  })
})

// The pre-refactor behaviour: an unreachable server plugin was warned about and
// then treated as "nothing configured", so all three commands still worked. A
// command that instead refused to run would strand the user in a TUI where
// /fusion cannot repair what it cannot read.
describe("commands when the server plugin is unreachable", () => {
  it("warns once and walks /fusion unprefilled rather than refusing", async () => {
    await withWarnings(async (warnings) => {
      const h = harness({ failRead: true, selects: effortWalk(), models: EFFORT_MODELS })
      try {
        await h.command("fusion.pair").run()

        const unreachable = warnings.filter((line) => /server plugin unreachable: Error: connection refused/.test(line))
        assert.equal(unreachable.length, 1)
        // The whole walk ran, with nothing prefilled: a configured pair would
        // have put the current model on the lead-model select.
        assert.deepEqual(
          h.selects.map((call) => call.title),
          [
            "Fusion 0/4 · Preset",
            "Fusion 1/4 · Lead model",
            "Fusion 2/4 · Lead effort",
            "Fusion 3/4 · Sidekick model",
            "Fusion 4/4 · Sidekick effort",
          ],
        )
        assert.ok(
          h.selects.filter((call) => call.title.includes("model")).every((call) => call.current === undefined),
          "no select was prefilled from a pair that could not be read",
        )
        assert.deepEqual(h.saves, [
          {
            lead: { ...SAVED_PAIR.lead, variant: "high" },
            sidekick: { ...SAVED_PAIR.sidekick, variant: "high" },
          },
        ])
        assert.deepEqual(
          h.toasts.map((toast) => toast.variant),
          ["success"],
          "no refusal toast, only the success one",
        )
      } finally {
        await h.stop()
      }
    })
  })

  it("still reports no pair picked for /fusion-stats", async () => {
    await withWarnings(async () => {
      const h = harness({ failRead: true })
      try {
        await h.command("fusion.stats").run()
        assert.deepEqual(h.alerts, [{ title: "Fusion savings", message: "no pair picked yet — run /fusion" }])
        assert.deepEqual(h.shown, [])
      } finally {
        await h.stop()
      }
    })
  })

  it("still shows the defaults for the pairing summary", async () => {
    await withWarnings(async () => {
      const h = harness({ failRead: true })
      try {
        await h.command("fusion.show").run()
        assert.equal(h.alerts.length, 1)
        assert.equal(h.alerts[0].title, "Fusion pairing")
        assert.deepEqual(h.alerts[0].message.split("\n").slice(0, 2), [
          "lead     not picked (OpenCode default model) → agent fusion",
          "sidekick not picked (OpenCode default model) → agent sidekick",
        ])
      } finally {
        await h.stop()
      }
    })
  })
})
