/**
 * Bot-fill strategies for the dev-only "fill the table with bots" feature.
 *
 * These are intentionally simple — they are NOT a competitive opponent. Their
 * job is to keep a hand moving so a human can play test the frontend.
 *
 * Sizing rules (all strategies):
 *   - Facing no bet: never fold; 70% check, 30% bet min (= bigBlind).
 *   - Facing a bet:  weighted fold/call/min-raise per strategy below.
 *   - "min-raise" target = currentBet + lastRaiseIncrement (falls back to
 *     bigBlind when no prior raise this street). The server still validates
 *     the legal min-raise; if our compute is short, the engine returns
 *     "Raise must be higher than current bet" and we soft-retry as a call.
 *   - All-in if the requested action exceeds remaining stack.
 */
import type { BotGameState, BotStrategy, Decision } from './types';

export type StrategyName = 'random' | 'tight' | 'loose';

interface Weights {
  /** weight for fold when facing a bet */
  fold: number;
  /** weight for call/check when facing a bet */
  call: number;
  /** weight for min-raise when facing a bet */
  raise: number;
}

const WEIGHTS: Record<StrategyName, Weights> = {
  random: { fold: 0.30, call: 0.50, raise: 0.20 },
  tight:  { fold: 0.60, call: 0.35, raise: 0.05 },
  loose:  { fold: 0.10, call: 0.60, raise: 0.30 },
};

/** Convert micro-chip string to chips. */
function toChips(microStr: string): number {
  return Number(microStr) / 1_000_000;
}

/** Safe BigInt parse: returns 0n on falsy/invalid input. */
function toBig(microStr: string | undefined): bigint {
  if (!microStr) return 0n;
  try { return BigInt(microStr); } catch { return 0n; }
}

/**
 * Pure decision function — pulled out for tests.
 * `rng` defaults to Math.random; tests can inject a deterministic source.
 */
export function decideForStrategy(
  name: StrategyName,
  state: BotGameState,
  rng: () => number = Math.random
): Decision {
  const w = WEIGHTS[name];

  // BigInt-precise legality checks (chip math is sub-unit; converting to
  // floats first can collapse tiny owe values to 0 and produce illegal
  // checks).
  const oweBig = toBig(state.amountToCall);
  const stackBig = toBig(state.myPlayer.chipStack);
  const stageBetBig = toBig(state.myPlayer.currentStageBet);

  const owe = toChips(state.amountToCall);
  const stack = toChips(state.myPlayer.chipStack);
  const bb = toChips(state.bigBlind);
  const currentBet = toChips(state.currentBet);
  const lastInc = state.lastRaiseIncrement ? toChips(state.lastRaiseIncrement) : bb;

  // Defensive: if our stack is gone, the engine should have moved on, but
  // never send a bet/raise we can't pay. If we still somehow owe chips, the
  // only legal move is fold (we can't call with 0 stack).
  if (stackBig <= 0n) {
    return oweBig === 0n ? { action: 'check' } : { action: 'fold' };
  }

  // No bet to face: never fold (poker rule). 70% check, 30% min-bet.
  if (oweBig === 0n) {
    if (rng() < 0.7) return { action: 'check' };
    const target = Math.max(bb, 1);
    if (target >= stack) return { action: 'all-in' };
    return { action: 'raise', raiseAmount: target };
  }

  // Facing a bet: weighted random across fold/call/raise.
  // If we'd have to go all-in just to call, force all-in.
  const r = rng();
  if (r < w.fold) {
    return { action: 'fold' };
  }
  if (r < w.fold + w.call) {
    if (oweBig >= stackBig) return { action: 'all-in' };
    return { action: 'call' };
  }
  // Min-raise: target total bet for this street.
  // The engine rule (packages/backend/src/services/pokerActions.ts) is:
  //   raiseTotal >= currentBet + lastRaiseIncrement
  // where lastRaiseIncrement = max increment of any FULL raise this street,
  // and defaults to bigBlind only if there has been no betting at all on this
  // street. Once someone has bet X on a fresh street, X itself becomes the
  // increment for subsequent raises.
  //
  // To stay safe we floor lastRaiseIncrement at max(currentBet, bb): if there
  // is an existing currentBet, that bet itself is at least the increment.
  // Adding a +1 micro-chip safety margin guards against float ↔ BigInt
  // rounding when we serialize raiseAmount back to a Number.
  const safeLastInc = Math.max(lastInc, currentBet, bb);
  const minRaiseTarget = currentBet + safeLastInc;
  // Total commitment for the raise = minRaiseTarget; we've already put in
  // `stageBet` this street, so additional cost = minRaiseTarget - stageBet.
  // We can only raise if that additional cost is strictly less than stack
  // (equal would be all-in, not a sized raise).
  const minRaiseTargetBig = BigInt(Math.floor(minRaiseTarget * 1_000_000));
  const additionalCost = minRaiseTargetBig - stageBetBig;
  if (additionalCost >= stackBig) {
    return { action: 'all-in' };
  }
  return { action: 'raise', raiseAmount: minRaiseTarget };
}

/** Build a fully-featured BotStrategy object from a name. */
export function strategy(name: StrategyName): BotStrategy {
  return {
    name,
    decide: (state, rng) => decideForStrategy(name, state, rng),
  };
}

export const VALID_STRATEGIES: ReadonlyArray<StrategyName> = ['random', 'tight', 'loose'];

export function isStrategyName(s: unknown): s is StrategyName {
  return typeof s === 'string' && (VALID_STRATEGIES as readonly string[]).includes(s);
}
