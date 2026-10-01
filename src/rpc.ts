/**
 * The RPC contract between the server plugin and the TUI plugin: the JSON
 * schemas both plugins register against, the TypeScript types those schemas
 * describe, and the one typed client adapter that bridges them.
 *
 * Deliberately a plain object literal rather than `Rpc.define(...)`: `define`
 * is the identity function, but importing it at runtime means the plugin needs
 * `@opencode/plugin` resolvable next to it. A literal plus a type-only import
 * gets the same type checking with no runtime resolution requirement.
 *
 * `Rpc.Input`/`Rpc.Output`/`Rpc.EventData` of a JSON Schema resolve to
 * `unknown`/`unknown`/`Record<string, unknown>`: the schemas carry no
 * TypeScript types. So every wire type below is written out by hand, sits
 * beside the schema it describes, and `fusionClient` is the single seam where
 * a value crosses from `unknown` into one of them.
 */
import type { Rpc } from "@opencode/schema/rpc"
import type { FusionPair, ModelRef } from "./pair.ts"

const modelRef = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    modelID: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "modelID"],
  additionalProperties: false,
}

const pair = {
  type: "object",
  properties: {
    lead: modelRef,
    sidekick: modelRef,
    leadAgent: { type: "string" },
    sidekickAgent: { type: "string" },
  },
  required: ["lead", "sidekick", "leadAgent", "sidekickAgent"],
  additionalProperties: false,
}

const pairResult = {
  type: "object",
  properties: {
    configured: { type: "boolean" },
    pair,
    leadAgent: { type: "string" },
    sidekickAgent: { type: "string" },
  },
  required: ["configured", "leadAgent", "sidekickAgent"],
  additionalProperties: false,
}

const noArguments = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

export const Fusion = {
  id: "fusion",
  methods: {
    getPair: {
      input: noArguments,
      output: pairResult,
    },
    setPair: {
      input: {
        type: "object",
        properties: {
          lead: modelRef,
          sidekick: modelRef,
        },
        required: ["lead", "sidekick"],
        additionalProperties: false,
      },
      output: pairResult,
    },
    apply: {
      input: noArguments,
      output: {
        type: "object",
        properties: { applied: { type: "boolean" } },
        required: ["applied"],
        additionalProperties: false,
      },
    },
    sidekicks: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          current: { type: "string" },
          sessionIDs: { type: "array", items: { type: "string" } },
          running: { type: "boolean" },
        },
        required: ["sessionIDs", "running"],
        additionalProperties: false,
      },
    },
  },
  events: {
    pairChanged: {
      schema: {
        type: "object",
        properties: {
          lead: modelRef,
          sidekick: modelRef,
        },
        required: ["lead", "sidekick"],
        additionalProperties: false,
      },
    },
    handoffChanged: {
      schema: {
        type: "object",
        properties: {
          leadSessionID: { type: "string" },
          sidekickSessionID: { type: "string" },
          running: { type: "boolean" },
        },
        required: ["leadSessionID", "sidekickSessionID", "running"],
        additionalProperties: false,
      },
    },
  },
} satisfies Rpc.PortableDefinition

export type FusionRpc = typeof Fusion

// --- Wire types -------------------------------------------------------------
//
// Hand-written twins of the schemas above. Each one names its schema key, and
// the two must stay structurally consistent: the schemas are what the server
// actually sends, these are what both plugins believe it sends.

/** `pairResult` — the output of both `getPair` and `setPair`. `pair` is absent until one is picked. */
export type PairStatus = {
  configured: boolean
  pair?: FusionPair
  leadAgent: string
  sidekickAgent: string
}

/** The `sidekicks` output for one lead session: its sidekick sessions, newest last. */
export type SidekicksResult = {
  current?: string
  sessionIDs: string[]
  running: boolean
}

/** The `apply` output: whether the agent reload ran. */
export type ApplyResult = {
  applied: boolean
}

/** The `setPair` input: the two model refs to pair. */
export type SetPairInput = {
  lead: ModelRef
  sidekick: ModelRef
}

/** The `sidekicks` input: the lead session to look up. */
export type SidekicksInput = {
  sessionID: string
}

/** `pairChanged` event data: the pair the server just saved. */
export type PairChanged = {
  lead: ModelRef
  sidekick: ModelRef
}

/** `handoffChanged` event data: the handoff state of one lead session. */
export type HandoffChanged = {
  leadSessionID: string
  sidekickSessionID: string
  running: boolean
}

/** Event name → unwrapped event data, for `FusionClient.events.on`. */
export type FusionEvents = {
  pairChanged: PairChanged
  handoffChanged: HandoffChanged
}

/** Event names the contract defines. */
export type FusionEventName = keyof FusionEvents & string

// --- Typed client -----------------------------------------------------------

/**
 * What the host hands an `events.on` handler: an envelope whose `data` is
 * `Readonly<Record<string, unknown>>`, because the event schemas are JSON
 * Schemas. Structural, so it matches the host's own payload type.
 */
interface RawFusionEvent {
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * What `context.client.rpc(Fusion)` returns: the four methods with `unknown`
 * in and `unknown` out, plus the generic event subscription. Declared
 * structurally and without the trailing `options` parameter so that the real
 * `RpcClient<Fusion>` is assignable to it with no cast at the call site.
 */
export interface RawFusionClient {
  getPair(input: unknown): Promise<unknown>
  setPair(input: unknown): Promise<unknown>
  apply(input: unknown): Promise<unknown>
  sidekicks(input: unknown): Promise<unknown>
  events: {
    on<Name extends FusionEventName>(
      name: Name,
      handler: (event: RawFusionEvent) => Promise<void> | void,
    ): () => void
  }
}

/** The Fusion RPC as the TUI uses it: typed in, typed out, events unwrapped. */
export interface FusionClient {
  getPair(): Promise<PairStatus>
  setPair(input: SetPairInput): Promise<PairStatus>
  apply(): Promise<ApplyResult>
  sidekicks(input: SidekicksInput): Promise<SidekicksResult>
  events: {
    /** Hands the handler the event's data, not the envelope; returns the disposer. */
    on<Name extends FusionEventName>(name: Name, handler: (event: FusionEvents[Name]) => Promise<void> | void): () => void
  }
}

/**
 * The single boundary between "the schemas carry no types" and the rest of the
 * plugin. Every cast in the codebase that touches an RPC value happens here.
 */
export function fusionClient(raw: RawFusionClient): FusionClient {
  return {
    getPair: async () => (await raw.getPair({})) as PairStatus,
    setPair: async (input) => (await raw.setPair(input)) as PairStatus,
    apply: async () => (await raw.apply({})) as ApplyResult,
    sidekicks: async (input) => (await raw.sidekicks(input)) as SidekicksResult,
    events: {
      on: <Name extends FusionEventName>(name: Name, handler: (event: FusionEvents[Name]) => Promise<void> | void) =>
        raw.events.on(name, async (event) => {
          await handler(event.data as FusionEvents[Name])
        }),
    },
  }
}
