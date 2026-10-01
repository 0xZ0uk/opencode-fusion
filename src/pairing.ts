/**
 * The pairing wizard behind `/fusion`.
 *
 * One walk over the models OpenCode has at this location: preset → lead effort
 * → sidekick effort, with two model selects added when the chosen preset does
 * not fit here. Effort is OpenCode's own model `variant`; the model default is
 * the empty string, and a model with no variants is never asked about.
 *
 * The whole walk is one function, `pickPair`, with one cancellation convention:
 * it returns `undefined` if the user backs out at any step. The three-way
 * "undefined / null / empty string" the dialogs used to hand around is internal
 * and never leaves this module.
 *
 * Host calls arrive as two structural seams — `Dialogs` and `Catalogue` — so
 * the walk can be driven by fakes. Only type imports from `@opencode/*`.
 */
import type { ModelCost, ModelInfo } from "@opencode/client"
import { PRESETS, familyOf, resolvePreset, type PresetModel } from "./presets.ts"
import { describeRates } from "./costs.ts"
import type { ModelRef } from "./pair.ts"

/** Dialog value meaning "use the model's default effort". */
const MODEL_DEFAULT = ""

/** One row in a select. `disabled` greys a preset out; `category` groups models. */
export type SelectOption = {
  readonly title: string
  readonly value: string
  readonly description?: string
  readonly category?: string
  readonly disabled?: boolean
}

export type Dialogs = {
  select(input: {
    title: string
    placeholder: string
    options: readonly SelectOption[]
    current?: string
  }): Promise<string | undefined>
  alert(input: { title: string; message: string }): Promise<void>
  toast(input: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }): void
}

/** The structural model the wizard reads. The TUI adapts the host's ModelInfo. */
export type WizardModel = PresetModel & {
  readonly name: string
  readonly cost?: readonly ModelCost[]
  readonly limit?: { readonly context?: number } | undefined
  readonly variants?: readonly { readonly id: string }[] | undefined
}

/** The host's model, mapped to the structural shape the wizard seam reads. */
export const toWizardModel = (
  model: Pick<ModelInfo, "id" | "providerID" | "name" | "cost" | "limit" | "variants">,
): WizardModel => ({
  providerID: model.providerID,
  modelID: model.id,
  name: model.name,
  cost: model.cost,
  limit: model.limit,
  variants: model.variants,
})

export type Catalogue = {
  /** The models available at this location, already synced. */
  models(): Promise<readonly WizardModel[]>
}

export type PairingResult = {
  readonly pair: { readonly lead: ModelRef; readonly sidekick: ModelRef }
  /** Non-fatal notes for the caller to fold into its own toast, e.g. same family. */
  readonly warnings: readonly string[]
}

// --- row builders ------------------------------------------------------------

const modelKey = (ref: PresetModel): string => `${ref.providerID}|${ref.modelID}`

const splitKey = (value: string): PresetModel | undefined => {
  const index = value.indexOf("|")
  if (index <= 0) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

const contextSize = (model: WizardModel): string => {
  const context = model.limit?.context
  return typeof context === "number" ? `${Math.round(context / 1000)}k ctx` : "unknown ctx"
}

const modelOptions = (models: readonly WizardModel[]): SelectOption[] =>
  models.map((model) => ({
    title: model.name,
    value: modelKey(model),
    description: `${model.providerID} · ${contextSize(model)} · ${describeRates(model.cost)}`,
    category: model.providerID,
  }))

const effortOptions = (model: WizardModel): SelectOption[] => {
  const variants = (model.variants ?? []).map((variant) => variant.id).filter(Boolean)
  return [
    { title: "model default", value: MODEL_DEFAULT, description: `${model.name} default effort` },
    ...variants.map((id) => ({ title: id, value: id, description: `effort variant "${id}"` })),
  ]
}

// --- the walk ---------------------------------------------------------------

/** Internal cancel marker, so one walk can bail from any step. */
const CANCELLED = Symbol("cancelled")

export function createPairing(deps: {
  dialogs: Dialogs
  catalogue: Catalogue
}): (current?: { lead?: ModelRef; sidekick?: ModelRef }) => Promise<PairingResult | undefined> {
  const { dialogs, catalogue } = deps

  const pickModel = async (
    title: string,
    models: readonly WizardModel[],
    current?: ModelRef,
  ): Promise<PresetModel | typeof CANCELLED> => {
    const value = await dialogs.select({
      title,
      placeholder: "Search models",
      options: modelOptions(models),
      ...(current ? { current: modelKey(current) } : {}),
    })
    if (!value) return CANCELLED
    return splitKey(value) ?? CANCELLED
  }

  /**
   * The chosen variant, or the model default when the model has none to choose
   * from — a model with no variants is not worth a dialog. Prefill only applies
   * when the prefilled model is the one being asked about.
   */
  const pickEffort = async (
    title: string,
    models: readonly WizardModel[],
    picked: PresetModel,
    current?: ModelRef,
  ): Promise<string | typeof CANCELLED> => {
    const model = models.find((entry) => modelKey(entry) === modelKey(picked))
    if (!model || (model.variants ?? []).length === 0) return MODEL_DEFAULT
    const currentVariant = current && modelKey(current) === modelKey(picked) ? current.variant : undefined
    const value = await dialogs.select({
      title,
      placeholder: "Effort",
      options: effortOptions(model),
      current: currentVariant ?? MODEL_DEFAULT,
    })
    return value === undefined ? CANCELLED : value
  }

  /** The effort onto a ref: the model default leaves the variant key off. */
  const withEffort = (ref: PresetModel, effort: string): ModelRef => ({
    ...ref,
    ...(effort ? { variant: effort } : {}),
  })

  const presetOptions = (models: readonly WizardModel[]): SelectOption[] =>
    PRESETS.map((preset) => {
      if (!preset.providerID) {
        return { title: preset.name, value: preset.name, description: "pick lead and sidekick by hand" }
      }
      const lead = resolvePreset(models, preset, "lead")
      const sidekick = resolvePreset(models, preset, "sidekick")
      return lead && sidekick
        ? { title: preset.name, value: preset.name, description: `${lead.name} lead · ${sidekick.name} sidekick` }
        : { title: preset.name, value: preset.name, description: "not available at this location", disabled: true }
    })

  return async (current = {}) => {
    const models = await catalogue.models()
    if (models.length === 0) {
      dialogs.toast({ message: "Fusion: no models available at this location", variant: "error" })
      return undefined
    }

    const presetName = await dialogs.select({
      title: "Fusion 0/4 · Preset",
      placeholder: "Preset or custom",
      options: presetOptions(models),
    })
    if (!presetName) return undefined

    const preset = PRESETS.find((entry) => entry.name === presetName)
    const presetLead = preset ? resolvePreset(models, preset, "lead") : undefined
    const presetSidekick = preset ? resolvePreset(models, preset, "sidekick") : undefined
    const presetFits = Boolean(presetLead && presetSidekick)
    if (preset && preset.name !== "Custom" && !presetFits) {
      dialogs.toast({
        message: `Fusion: preset "${preset.name}" has no matching models here — pick manually`,
        variant: "error",
      })
    }

    let lead: PresetModel
    let sidekick: PresetModel
    let leadEffort: string
    let sidekickEffort: string

    if (presetFits && presetLead && presetSidekick) {
      // The preset named both models, so only the effort is open.
      lead = { providerID: presetLead.providerID, modelID: presetLead.modelID }
      sidekick = { providerID: presetSidekick.providerID, modelID: presetSidekick.modelID }
      const leadPicked = await pickEffort(
        `Fusion 2/4 · Lead effort (${presetLead.name})`,
        models,
        lead,
        current.lead,
      )
      if (leadPicked === CANCELLED) return undefined
      leadEffort = leadPicked
      const sidekickPicked = await pickEffort(
        `Fusion 4/4 · Sidekick effort (${presetSidekick.name})`,
        models,
        sidekick,
        current.sidekick,
      )
      if (sidekickPicked === CANCELLED) return undefined
      sidekickEffort = sidekickPicked
    } else {
      const leadPicked = await pickModel("Fusion 1/4 · Lead model", models, current.lead)
      if (leadPicked === CANCELLED) return undefined
      lead = leadPicked
      const leadVariants = await pickEffort("Fusion 2/4 · Lead effort", models, lead, current.lead)
      if (leadVariants === CANCELLED) return undefined
      leadEffort = leadVariants

      const sidekickPicked = await pickModel("Fusion 3/4 · Sidekick model", models, current.sidekick)
      if (sidekickPicked === CANCELLED) return undefined
      sidekick = sidekickPicked
      const sidekickVariants = await pickEffort("Fusion 4/4 · Sidekick effort", models, sidekick, current.sidekick)
      if (sidekickVariants === CANCELLED) return undefined
      sidekickEffort = sidekickVariants
    }

    const pair = { lead: withEffort(lead, leadEffort), sidekick: withEffort(sidekick, sidekickEffort) }

    // Same family on both sides means no independent cross-vendor review, which
    // is a note for the caller's success toast, not a refusal.
    const leadFamily = familyOf(pair.lead)
    const sidekickFamily = familyOf(pair.sidekick)
    const warnings =
      leadFamily === sidekickFamily
        ? [`same family (${leadFamily}): no independent cross-vendor review`]
        : []

    return { pair, warnings }
  }
}
