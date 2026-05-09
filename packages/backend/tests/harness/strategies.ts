/**
 * Bot strategies. Pure decision functions over GameState.
 *
 * Each strategy returns the next action. The harness sends it via the
 * /games/:id/action endpoint, exactly as a real client would.
 *
 * raiseAmount is in CHIPS (the user-facing unit), not micro-units. The API
 * multiplies by 1_000_000 internally.
 */
import type { GameState } from './botClient';

export interface Decision {
  action: 'fold' | 'check' | 'call' | 'raise' | 'all-in';
  /** chips, only used for raise */
  raiseAmount?: number;
}

export interface BotStrategy {
  name: string;
  decide(state: GameState): Decision;
}

/** Convert micro-chip string to chips. */
function chips(microStr: string): number {
  return Number(microStr) / 1_000_000;
}

/** Random in [a, b). */
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/**
 * Calling station: never folds, calls everything, never raises. Cheap baseline.
 */
export const CallingStation: BotStrategy = {
  name: 'calling-station',
  decide(state) {
    const owe = chips(state.amountToCall);
    if (owe === 0) return { action: 'check' };
    const stack = chips(state.myPlayer.chipStack);
    if (owe >= stack) return { action: 'all-in' };
    return { action: 'call' };
  },
};

/**
 * Random reasonable: mixes check/call/fold/raise with sane sizing.
 */
export const RandomReasonable: BotStrategy = {
  name: 'random-reasonable',
  decide(state) {
    const owe = chips(state.amountToCall);
    const stack = chips(state.myPlayer.chipStack);
    const bb = chips(state.bigBlind);
    const pot = chips(state.pot);
    const r = Math.random();

    if (owe === 0) {
      // Free to check or bet
      if (r < 0.7) return { action: 'check' };
      const raise = Math.min(stack, Math.max(bb, Math.floor(pot * rand(0.4, 0.8))));
      if (raise >= stack) return { action: 'all-in' };
      return { action: 'raise', raiseAmount: raise };
    }
    // Facing a bet
    if (r < 0.15 && stack > owe * 2) return { action: 'fold' };
    if (r < 0.85) {
      if (owe >= stack) return { action: 'all-in' };
      return { action: 'call' };
    }
    // Raise
    const raiseTo = Math.min(stack, owe + Math.max(bb * 2, Math.floor(pot * rand(0.5, 1.0))));
    if (raiseTo >= stack) return { action: 'all-in' };
    return { action: 'raise', raiseAmount: raiseTo };
  },
};

/**
 * Aggro: raises a lot, all-ins frequently. Forces showdowns and side pots.
 */
export const Aggro: BotStrategy = {
  name: 'aggro',
  decide(state) {
    const owe = chips(state.amountToCall);
    const stack = chips(state.myPlayer.chipStack);
    const bb = chips(state.bigBlind);
    const pot = chips(state.pot);
    const r = Math.random();

    // All-in 20% of the time when we have ≤ 10bb (real short-stack play).
    if (stack <= bb * 10 && r < 0.4) return { action: 'all-in' };

    if (owe === 0) {
      if (r < 0.2) return { action: 'check' };
      const raise = Math.min(stack, Math.max(bb * 3, Math.floor(pot * rand(0.6, 1.2))));
      if (raise >= stack) return { action: 'all-in' };
      return { action: 'raise', raiseAmount: raise };
    }
    if (r < 0.05) return { action: 'fold' };
    if (r < 0.5) {
      if (owe >= stack) return { action: 'all-in' };
      return { action: 'call' };
    }
    const raiseTo = Math.min(stack, owe + Math.max(bb * 2, Math.floor(pot * rand(0.7, 1.5))));
    if (raiseTo >= stack) return { action: 'all-in' };
    return { action: 'raise', raiseAmount: raiseTo };
  },
};

/**
 * Nit: folds to almost any aggression, only checks/calls cheaply.
 */
export const Nit: BotStrategy = {
  name: 'nit',
  decide(state) {
    const owe = chips(state.amountToCall);
    const bb = chips(state.bigBlind);
    if (owe === 0) return { action: 'check' };
    if (owe <= bb) return { action: 'call' };
    return { action: 'fold' };
  },
};

/**
 * Always all-in: useful for forcing the all-in code paths every hand.
 */
export const AlwaysAllIn: BotStrategy = {
  name: 'always-all-in',
  decide(state) {
    const owe = chips(state.amountToCall);
    const stack = chips(state.myPlayer.chipStack);
    if (stack === 0) {
      // Already all-in; check if free, otherwise fold (we have no chips left, server should treat us as all-in).
      return owe === 0 ? { action: 'check' } : { action: 'fold' };
    }
    return { action: 'all-in' };
  },
};

/**
 * AlwaysFold: folds whenever facing any bet, checks otherwise. Used for
 * heads-up walk testing (SB folds, BB takes blinds).
 */
export const AlwaysFold: BotStrategy = {
  name: 'always-fold',
  decide(state) {
    const owe = chips(state.amountToCall);
    if (owe === 0) return { action: 'check' };
    return { action: 'fold' };
  },
};

/**
 * MinRaiser: always min-raises (or calls if can't). Used for reopening-action
 * edge cases where we want predictable raise sizing.
 */
export const MinRaiser: BotStrategy = {
  name: 'min-raiser',
  decide(state) {
    const owe = chips(state.amountToCall);
    const stack = chips(state.myPlayer.chipStack);
    const bb = chips(state.bigBlind);
    if (stack === 0) return owe === 0 ? { action: 'check' } : { action: 'fold' };
    // Min-raise: target = call amount + one bigBlind (server enforces actual
    // min-raise rules; this just sends a small legal bump every time).
    const target = Math.max(bb * 2, Math.floor(owe + bb));
    if (target >= stack) return { action: 'all-in' };
    return { action: 'raise', raiseAmount: target };
  },
};

/**
 * Slowpoke: deliberately variable thinkMs (handled by botClient via cfg);
 * decision-wise behaves like RandomReasonable. The harness varies thinkMs
 * for clock-drift coverage.
 */
export const Slowpoke: BotStrategy = {
  name: 'slowpoke',
  decide: RandomReasonable.decide,
};

export const ALL_STRATEGIES = [CallingStation, RandomReasonable, Aggro, Nit, AlwaysAllIn, AlwaysFold, MinRaiser, Slowpoke];
