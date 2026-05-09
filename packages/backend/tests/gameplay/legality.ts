/**
 * Legality oracle.
 *
 * Given a player view at their decision point, returns the set of legal
 * actions and the legal raise range. Used to:
 *   - validate that a script's intended action is actually legal at that
 *     step (so test failures surface as "your script is wrong" not "the
 *     game is broken")
 *   - drive the legality-rejection sub-tests that prove illegal inputs
 *     produce 4xx-class rejections (Gerald audit-20 ask)
 *
 * Mirrors `pokerActions.ts` validation. If the two ever diverge, that's a
 * test bug worth fixing — the oracle is the canonical legal-set documentation.
 */

import type { PlayerView } from '../sim/strategy';

export type LegalActionKind = 'fold' | 'check' | 'call' | 'raise' | 'all-in';

export interface LegalActions {
  kinds: LegalActionKind[];
  /** Min legal raise total (i.e. raise *to* this amount). Undefined if raise illegal. */
  minRaiseTotal?: bigint;
  /** Max legal raise total (== chipStack + alreadyInOnStreet for all-in). */
  maxRaiseTotal?: bigint;
  /** Reasoning, useful for diagnostic output. */
  why: string[];
}

/**
 * Compute the legal actions for the active player.
 *
 * @param view  PlayerView from the simulator (mirrors the engine's view).
 * @param lastRaiseIncrement  The size of the last legal raise increment
 *   on this street, in micro-units. If no raise has happened on this
 *   street, equals the bigBlind.
 */
export function legalActions(view: PlayerView, lastRaiseIncrement: bigint): LegalActions {
  const owed = view.currentBet - view.alreadyInOnStreet;
  const stack = view.chipStack;
  const why: string[] = [];
  const kinds: LegalActionKind[] = [];

  if (stack === 0n) {
    // Already all-in. Engine should not even be polling us.
    why.push('player has zero chip stack');
    return { kinds: ['check'], why };
  }

  // fold: always legal (well, only meaningful when facing a bet, but the
  // engine accepts a fold even when checking is free).
  kinds.push('fold');

  if (owed === 0n) {
    kinds.push('check');
    why.push('owed=0 → check legal');
  } else {
    if (owed >= stack) {
      // Can only call all-in (treated as 'all-in' by the engine when stack < owed).
      kinds.push('all-in');
      why.push(`owed=${owed} >= stack=${stack} → call is all-in`);
    } else {
      kinds.push('call');
      why.push(`owed=${owed} < stack=${stack} → call legal`);
    }
  }

  // Raise: legal if we have chips above the call amount.
  // Min raise total = currentBet + lastRaiseIncrement.
  // Max raise total = alreadyInOnStreet + stack (going all-in).
  const minRaiseTotal = view.currentBet + lastRaiseIncrement;
  const maxRaiseTotal = view.alreadyInOnStreet + stack;

  if (maxRaiseTotal > view.currentBet) {
    if (maxRaiseTotal >= minRaiseTotal) {
      kinds.push('raise');
      why.push(`raise legal in [${minRaiseTotal}, ${maxRaiseTotal}]`);
    } else {
      // Stack only allows a short shove that doesn't reach min-raise.
      // Engine accepts as all-in but does NOT reopen action for prior aggressors.
      kinds.push('all-in');
      why.push(`stack only allows short all-in (max=${maxRaiseTotal} < min=${minRaiseTotal})`);
    }
  }

  // 'all-in' is also explicitly legal as a synonym for "shove for max".
  if (!kinds.includes('all-in') && stack > 0n) {
    kinds.push('all-in');
    why.push('all-in always legal when stack > 0');
  }

  return { kinds, minRaiseTotal, maxRaiseTotal, why };
}

/**
 * Validate that an intended action is legal. Used by the script DSL
 * before sending the action to the engine — gives a clear "your script
 * is wrong" message instead of a "Stale action" or generic rejection
 * from deep inside processAction.
 */
export function validateScriptedAction(
  view: PlayerView,
  lastRaiseIncrement: bigint,
  action: { kind: LegalActionKind; raiseTotal?: bigint }
): { ok: true } | { ok: false; reason: string; legal: LegalActions } {
  const legal = legalActions(view, lastRaiseIncrement);
  if (!legal.kinds.includes(action.kind)) {
    return {
      ok: false,
      reason: `action '${action.kind}' not legal here. Legal: [${legal.kinds.join(', ')}]`,
      legal,
    };
  }
  if (action.kind === 'raise') {
    if (action.raiseTotal == null) {
      return { ok: false, reason: 'raise requires raiseTotal', legal };
    }
    if (legal.minRaiseTotal == null || legal.maxRaiseTotal == null) {
      return { ok: false, reason: 'raise was claimed legal but no min/max range', legal };
    }
    if (action.raiseTotal < legal.minRaiseTotal) {
      return {
        ok: false,
        reason: `raise total ${action.raiseTotal} < min ${legal.minRaiseTotal}`,
        legal,
      };
    }
    if (action.raiseTotal > legal.maxRaiseTotal) {
      return {
        ok: false,
        reason: `raise total ${action.raiseTotal} > max ${legal.maxRaiseTotal} (would exceed stack)`,
        legal,
      };
    }
  }
  return { ok: true };
}
