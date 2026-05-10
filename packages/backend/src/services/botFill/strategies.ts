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
  const owe = toChips(state.amountToCall);
  const stack = toChips(state.myPlayer.chipStack);
  const bb = toChips(state.bigBlind);
  const currentBet = toChips(state.currentBet);
  const lastInc = state.lastRaiseIncrement ? toChips(state.lastRaiseIncrement) : bb;

  // Defensive: if our stack is gone, the engine should have moved on, but
  // never send a bet/raise we can't pay.
  if (stack <= 0) {
    return owe === 0 ? { action: 'check' } : { action: 'fold' };
  }

  // No bet to face: never fold (poker rule). 70% check, 30% min-bet.
  if (owe === 0) {
    if (rng() < 0.7) return { action: 'check' };
    const target = Math.max(bb, 1);
    if (target >= stack) return { action: 'all-in' };
    return { action: 'raise', raiseAmount: target };
  }

  // Facing a bet: weighted random across fold/call/raise.
  // If we'd have to go all-in just to call, the calling weight folds in
  // (all-in is a forced version of call here).
  const r = rng();
  if (r < w.fold) {
    return { action: 'fold' };
  }
  if (r < w.fold + w.call) {
    if (owe >= stack) return { action: 'all-in' };
    return { action: 'call' };
  }
  // Min-raise: target total bet for this street.
  // Note: the engine's `raiseAmount` is the absolute size of this street's
  // bet target, not the increment. Fall back to BB when lastInc < BB.
  const minRaiseTarget = currentBet + Math.max(lastInc, bb);
  if (minRaiseTarget >= stack + toChips(state.myPlayer.currentStageBet)) {
    // We can't afford a legal min-raise; shove instead.
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
