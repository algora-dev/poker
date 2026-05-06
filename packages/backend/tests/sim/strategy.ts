/**
 * tests/sim/strategy.ts
 *
 * Player strategies for the match simulator. A Strategy is a pure function:
 *   (view: PlayerView) => StrategyDecision
 *
 * Add new strategies here. Existing tests parameterize over a small library:
 *   - nit: always check, fold to any bet
 *   - callingStation: always calls (or checks if free), never raises/folds
 *   - aggro: raises 3xBB preflop, c-bets postflop, otherwise calls
 *   - random: seeded RNG over legal actions
 *   - script: hard-coded action list keyed by (handNumber, stage, seat)
 */

export interface PlayerView {
  /** Player's own seat index. */
  seatIndex: number;
  /** Player's userId (matches the GamePlayer.userId). */
  userId: string;
  /** Hand number (1-based) within the match. */
  handNumber: number;
  /** Current betting stage. */
  stage: 'preflop' | 'flop' | 'turn' | 'river';
  /** Current high-water bet on this street, in chips (6 decimals). */
  currentBet: bigint;
  /** Big blind size, in chips (6 decimals). */
  bigBlind: bigint;
  /** What this player has already put into THIS street. */
  alreadyInOnStreet: bigint;
  /** Player's remaining stack. */
  chipStack: bigint;
  /** Total pot before this action. */
  pot: bigint;
  /** Number of seated players still in the hand (not folded/eliminated). */
  livePlayers: number;
}

export type StrategyAction =
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'fold' }
  | { kind: 'raise'; totalChips: number } // raise target in chip units
  | { kind: 'all-in' };

export type Strategy = (view: PlayerView) => StrategyAction;

/**
 * Always check, fold to any bet. Useful for "this player is not the
 * aggressor this hand" scripted scenarios.
 */
export const nit: Strategy = (v) => {
  const owed = v.currentBet - v.alreadyInOnStreet;
  if (owed <= 0n) return { kind: 'check' };
  return { kind: 'fold' };
};

/**
 * Calls every bet, never raises, never folds (unless owed > stack -> all-in).
 */
export const callingStation: Strategy = (v) => {
  const owed = v.currentBet - v.alreadyInOnStreet;
  if (owed <= 0n) return { kind: 'check' };
  if (owed >= v.chipStack) return { kind: 'all-in' };
  return { kind: 'call' };
};

/**
 * Preflop: raise to 3xBB. Postflop: bet 1/2 pot if checked to, else call.
 * Folds when stack < BB.
 */
export const aggro: Strategy = (v) => {
  if (v.chipStack < v.bigBlind) return { kind: 'all-in' };
  const owed = v.currentBet - v.alreadyInOnStreet;
  if (v.stage === 'preflop' && owed > 0n) {
    // Already a bet — re-raise to 3x current bet (capped to all-in).
    const targetUnits = Number(v.currentBet * 3n) / 1_000_000;
    if (BigInt(Math.floor(targetUnits * 1_000_000)) >= v.chipStack + v.alreadyInOnStreet) {
      return { kind: 'all-in' };
    }
    return { kind: 'raise', totalChips: targetUnits };
  }
  if (owed === 0n && v.pot > 0n) {
    // Bet 1/2 pot.
    const targetUnits = Number(v.pot / 2n) / 1_000_000;
    if (targetUnits <= Number(v.bigBlind) / 1_000_000) {
      // Below min-raise -> just check; let action close.
      return { kind: 'check' };
    }
    return { kind: 'raise', totalChips: targetUnits };
  }
  if (owed === 0n) return { kind: 'check' };
  if (owed >= v.chipStack) return { kind: 'all-in' };
  return { kind: 'call' };
};

/**
 * Tiny seeded RNG (Mulberry32). Deterministic for reproducible runs.
 */
export function seededRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random strategy. Uniform over {check/call, fold, occasional raise}. Seeded
 * so a failed run is reproducible by passing the same seed.
 */
export function randomStrategy(seed: number): Strategy {
  const rng = seededRng(seed);
  return (v) => {
    const owed = v.currentBet - v.alreadyInOnStreet;
    const r = rng();
    if (owed === 0n) {
      // Free to check. 80% check, 20% small bet.
      if (r < 0.8) return { kind: 'check' };
      const bb = Number(v.bigBlind) / 1_000_000;
      const targetUnits = Math.max(bb * 2, bb);
      return { kind: 'raise', totalChips: targetUnits };
    }
    // Owed > 0. 50% call, 30% fold, 20% raise (when we can afford it).
    if (r < 0.5) {
      if (owed >= v.chipStack) return { kind: 'all-in' };
      return { kind: 'call' };
    }
    if (r < 0.8) return { kind: 'fold' };
    const bb = Number(v.bigBlind) / 1_000_000;
    const cur = Number(v.currentBet) / 1_000_000;
    const targetUnits = cur + Math.max(bb, cur);
    return { kind: 'raise', totalChips: targetUnits };
  };
}

/**
 * Scripted strategy. Keyed by (handNumber, stage, seatIndex). If no script
 * entry matches, falls back to `fallback`.
 */
export type ScriptKey = string; // `${handNumber}:${stage}:${seatIndex}`
export function scriptKey(handNumber: number, stage: string, seatIndex: number): ScriptKey {
  return `${handNumber}:${stage}:${seatIndex}`;
}

export function scriptedStrategy(
  script: Record<ScriptKey, StrategyAction | StrategyAction[]>,
  fallback: Strategy = nit
): Strategy {
  // Track per-key call counts so a list of actions can be consumed in order.
  const calls = new Map<ScriptKey, number>();
  return (v) => {
    const key = scriptKey(v.handNumber, v.stage, v.seatIndex);
    const entry = script[key];
    if (entry == null) return fallback(v);
    if (Array.isArray(entry)) {
      const idx = calls.get(key) ?? 0;
      calls.set(key, idx + 1);
      return entry[idx] ?? fallback(v);
    }
    return entry;
  };
}
