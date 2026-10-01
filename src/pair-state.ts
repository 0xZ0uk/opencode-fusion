import { Context, Effect, Ref, Semaphore } from "effect"
import { normalizePair, type FusionPair } from "./pair.ts"
import type { PairStatus } from "./rpc.ts"
import type { FusionStorageService } from "./host.ts"

const PAIR_KEY = "pair"

export interface PairStateApi {
  current(): FusionPair | undefined
  status(): PairStatus
  setPair(input: unknown): Effect.Effect<PairStatus, unknown>
  apply(): Effect.Effect<{ applied: true }, unknown>
}

export class PairState extends Context.Service<PairState, PairStateApi>()("opencode-fusion/PairState") {}

export const makePairState = Effect.fn("makePairState")(function* (deps: {
  storage: FusionStorageService
  leadAgent: string
  sidekickAgent: string
  reload: Effect.Effect<void, unknown>
  changed: (pair: FusionPair) => Effect.Effect<void, unknown>
}) {
  const { storage, leadAgent, sidekickAgent, reload, changed } = deps
  const stored = normalizePair(yield* storage.get(PAIR_KEY))
  const ref = yield* Ref.make<FusionPair | undefined>(
    stored && { ...stored, leadAgent, sidekickAgent },
  )
  const gate = yield* Semaphore.make(1)

  const current = () => Ref.getUnsafe(ref)

  // The one place the `pairResult` shape is built: both setPair returns and
  // getPair go through here, so the wire shape cannot drift between them.
  const status = (): PairStatus => {
    const pair = Ref.getUnsafe(ref)
    return {
      configured: pair !== undefined,
      ...(pair ? { pair } : {}),
      leadAgent,
      sidekickAgent,
    }
  }

  const setPair = (input: unknown): Effect.Effect<PairStatus, unknown> =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const next = normalizePair(input)
        if (!next) return status()
        const proposed: FusionPair = { ...next, leadAgent, sidekickAgent }
        yield* storage.set(PAIR_KEY, proposed)
        yield* Ref.set(ref, proposed)
        yield* reload
        yield* changed(proposed)
        // `pair` is set by now, so the shared builder already reports it.
        return status()
      }),
    )

  const apply = (): Effect.Effect<{ applied: true }, unknown> => Effect.as(reload, { applied: true } as const)

  return { current, status, setPair, apply }
})
