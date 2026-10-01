import { Option, Schema } from "effect"
import { LEAD_AGENT, SIDEKICK_AGENT } from "./pair.ts"
import type { Enforcement } from "./policy.ts"

export interface FusionOptions {
  enforce: Enforcement
  leadAgent: string
  sidekickAgent: string
  /** Extra shell patterns the lead may run, appended to the default allowlist. */
  allowShell: readonly string[]
  /**
   * Let the sidekick edit files and run shell commands without asking. Default
   * true: a permission prompt in the sidekick's session is easy to miss and
   * stalls the handoff.
   */
  sidekickAutoApprove: boolean
  /**
   * Seconds a foreground `sidekick` call waits before detaching to the
   * background; the report still arrives as a follow-up message. Default 1800.
   */
  blockTimeoutSeconds: number
}

const enforceSchema = Schema.Union([Schema.Literal("full"), Schema.Literal("edits"), Schema.Literal("off")])

const nonemptyString = Schema.String.check(Schema.isMinLength(1))

const stringList = Schema.Array(Schema.String)

const timeoutSeconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(input))

export const normalizeOptions = (input: unknown): FusionOptions => {
  const record = decode(Schema.Record(Schema.String, Schema.Unknown), input) ?? {}
  return {
    enforce: decode(enforceSchema, record.enforce) ?? "full",
    leadAgent: decode(nonemptyString, record.leadAgent) ?? LEAD_AGENT,
    sidekickAgent: decode(nonemptyString, record.sidekickAgent) ?? SIDEKICK_AGENT,
    allowShell: decode(stringList, record.allowShell) ?? [],
    sidekickAutoApprove: decode(Schema.Boolean, record.sidekickAutoApprove) ?? true,
    blockTimeoutSeconds: decode(timeoutSeconds, record.blockTimeoutSeconds) ?? 1800,
  }
}
