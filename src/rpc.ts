/**
 * The RPC contract between the server plugin and the TUI plugin.
 *
 * Deliberately a plain object literal rather than `Rpc.define(...)`: `define`
 * is the identity function, but importing it at runtime means the plugin needs
 * `@opencode/plugin` resolvable next to it. A literal plus a type-only import
 * gets the same type checking with no runtime resolution requirement.
 */
import type { Rpc } from "@opencode/schema/rpc"

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
