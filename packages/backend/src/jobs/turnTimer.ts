// Turn timer: auto-acts when a player's turn expires (check if free, else fold).
// Re-enabled now that betting completion, all-in handling, and min-raise are stable.
//
// Tunables (env): TURN_TIMEOUT_MS, TURN_WARNING_MS, TURN_TICK_MS

import { prisma } from '../db/client';
import { processAction } from '../services/pokerActions';
import { advanceActivePlayerInTx } from '../services/advanceTurn';
import { broadcastGameState, emitGameEvent } from '../socket';
import { logger } from '../utils/logger';

const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS || '30000', 10); // 30s default
const TURN_WARNING_MS = parseInt(process.env.TURN_WARNING_MS || '10000', 10); // warn at 10s remaining
const TURN_TICK_MS    = parseInt(process.env.TURN_TICK_MS    || '2000',  10);

// Track hands we've already warned for, so the warning fires once per turn
// instead of every tick during the warning window.
// Key: `${handId}:${activePlayerIndex}`. Cleaned when the turn changes.
const warnedTurns = new Map<string, number>(); // value = timestamp warned

/**
 * Per-turn auto-action inflight lock.
 *
 * Why: every tick runs checkExpiredTurns(); if processAction() takes >TURN_TICK_MS
 * (it currently averages ~2.3s, sometimes >5s on Railway), the next tick wakes up
 * BEFORE the previous auto-action finished, finds the SAME expired hand, and fires
 * another auto-action. Result on prod was 4-8 concurrent processAction() calls,
 * mostly returning `Stale action - turn already advanced` and one occasionally
 * succeeding into a state that the others then corrupted.
 *
 * The lock is keyed by `${handId}:${activePlayerIndex}` so it auto-releases when
 * the turn advances (different idx) or the hand changes (different id).
 *
 * Process-local only — there is one backend instance per Railway deploy. If/when
 * we horizontally scale, this needs to move to a DB advisory lock.
 */
const inflightAutoActions = new Set<string>();

function turnKey(handId: string, idx: number) {
  return `${handId}:${idx}`;
}

/**
 * Safety net: any in-progress hand whose activePlayerIndex points at a
 * dead seat (folded / eliminated / all_in) is stalled. The 30s timeout
 * is the WRONG response here — the seat will never act. Advance the
 * turn immediately and broadcast.
 *
 * This catches:
 *   - Player left while it was their turn but the inline advance in
 *     leaveGame raced or was skipped for any reason.
 *   - A previous-hand fold that didn't roll the index forward cleanly.
 *   - Any future code path that mutates position without advancing.
 *
 * Runs every tick (cheap query) BEFORE the timeout-based scan.
 */
async function advanceDeadActiveSeats(nowMs: number) {
  const liveHands = await prisma.hand.findMany({
    where: { stage: { notIn: ['completed', 'showdown'] } },
    include: {
      game: { include: { players: { orderBy: { seatIndex: 'asc' } } } },
    },
  });
  for (const hand of liveHands) {
    const game = hand.game;
    if (game.status !== 'in_progress') continue;
    const seat = game.players[hand.activePlayerIndex];
    if (!seat) continue;
    if (seat.position === 'active' || seat.position === 'all_in') continue;
    // 'folded' or 'eliminated' — advance the turn immediately.
    try {
      const result = await prisma.$transaction(async (tx) => {
        return advanceActivePlayerInTx(tx, game.id, hand.id);
      });
      if (result.advanced) {
        try {
          const playerIds = game.players.map((p: any) => p.userId);
          await broadcastGameState(game.id, playerIds);
        } catch (e) {
          logger.warn('broadcastGameState after dead-seat advance failed', {
            gameId: game.id,
            error: (e as Error).message,
          });
        }
      }
    } catch (e) {
      logger.error('advanceDeadActiveSeats failed', {
        gameId: game.id,
        handId: hand.id,
        error: (e as Error).message,
      });
    }
  }
}

async function checkExpiredTurns() {
  const now = new Date();
  const nowMs = now.getTime();

  try {
    // 0) Safety net: advance any dead active seats first so the rest of
    //    this tick sees fresh, well-formed state.
    await advanceDeadActiveSeats(nowMs);

    // 1) Hard expiry: turnStartedAt older than the timeout
    const expiredHands = await prisma.hand.findMany({
      where: {
        stage: { notIn: ['completed', 'showdown'] },
        turnStartedAt: { lt: new Date(nowMs - TURN_TIMEOUT_MS) },
      },
      include: {
        game: { include: { players: { orderBy: { seatIndex: 'asc' } } } },
      },
    });

    for (const hand of expiredHands) {
      const game = hand.game;
      if (game.status !== 'in_progress') continue;
      if (!hand.turnStartedAt) continue;

      const activePlayer = game.players[hand.activePlayerIndex];
      if (!activePlayer) continue;
      if (activePlayer.position === 'folded' || activePlayer.position === 'eliminated' ||
          activePlayer.position === 'all_in') continue;

      // De-stampede: if a prior tick's auto-action for this exact turn is
      // still in flight, skip. The previous tick's processAction will either
      // succeed (advancing activePlayerIndex — next tick keys differently) or
      // throw (still expired — next tick retries cleanly).
      const lockKey = turnKey(hand.id, hand.activePlayerIndex);
      if (inflightAutoActions.has(lockKey)) continue;
      inflightAutoActions.add(lockKey);

      // Compute what the player owes this stage. Free check -> auto-check; else fold.
      const contribution = await prisma.handAction.aggregate({
        where: {
          handId: hand.id,
          userId: activePlayer.userId,
          stage: hand.stage,
        },
        _sum: { amount: true },
      });
      const alreadyIn = contribution._sum.amount || BigInt(0);
      const owes = hand.currentBet - alreadyIn;
      const autoAction: 'fold' | 'check' = owes > BigInt(0) ? 'fold' : 'check';

      logger.info('Turn timer expired — auto-acting', {
        gameId: game.id,
        handId: hand.id,
        userId: activePlayer.userId.slice(-6),
        autoAction,
        elapsedMs: nowMs - hand.turnStartedAt.getTime(),
      });

      try {
        await processAction(game.id, activePlayer.userId, autoAction);
        emitGameEvent(game.id, 'game:updated', {
          gameId: game.id,
          action: autoAction,
          userId: activePlayer.userId,
          autoAction: true,
        });
        // Phase 10 [H-03]: also push fresh per-player state so clients
        // don't have to refetch after every auto-fold/auto-check. Mirrors
        // what /api/games/:id/action does at the end of a real action.
        try {
          const playerIds = game.players.map((p: any) => p.userId);
          await broadcastGameState(game.id, playerIds);
        } catch (broadcastErr) {
          logger.warn('broadcastGameState after auto-action failed (non-fatal)', {
            gameId: game.id,
            error: (broadcastErr as Error).message,
          });
        }
        // Clear any warning state for this turn since it's over.
        warnedTurns.delete(lockKey);
      } catch (err) {
        // processAction can throw if the hand state changed mid-tick; safe to retry next tick.
        // Stale-action / no-active-hand are EXPECTED when the turn advanced
        // between the SELECT and the processAction call — log as info, not error.
        const msg = (err as Error).message ?? '';
        const lc = msg.toLowerCase();
        const expected = lc.includes('stale action') || lc.includes('no active hand')
          || lc.includes('not your turn');
        if (expected) {
          logger.info('Auto-action skipped (turn already advanced)', { gameId: game.id, reason: msg });
        } else {
          logger.error('Auto-action failed (will retry next tick)', { gameId: game.id, error: msg });
        }
      } finally {
        inflightAutoActions.delete(lockKey);
      }
    }

    // GC stale inflight locks every minute as a safety net (shouldn't be
    // needed because finally{} releases them, but defends against an
    // unhandled throw above the try{}).
    // (No timestamp on the set entries — if we ever see growth, switch to Map.)

    // 2) Warning: turn is in the warning window but not yet expired.
    //    Fire once per turn (deduped by warnedTurns map).
    const warningHands = await prisma.hand.findMany({
      where: {
        stage: { notIn: ['completed', 'showdown'] },
        turnStartedAt: {
          lt: new Date(nowMs - (TURN_TIMEOUT_MS - TURN_WARNING_MS)),
          gte: new Date(nowMs - TURN_TIMEOUT_MS),
        },
      },
      include: {
        game: { include: { players: { orderBy: { seatIndex: 'asc' } } } },
      },
    });

    for (const hand of warningHands) {
      const game = hand.game;
      if (game.status !== 'in_progress') continue;
      if (!hand.turnStartedAt) continue;
      const activePlayer = game.players[hand.activePlayerIndex];
      if (!activePlayer) continue;

      const key = turnKey(hand.id, hand.activePlayerIndex);
      if (warnedTurns.has(key)) continue; // already warned for this turn
      warnedTurns.set(key, nowMs);

      const elapsed = nowMs - hand.turnStartedAt.getTime();
      const remaining = Math.max(0, Math.ceil((TURN_TIMEOUT_MS - elapsed) / 1000));

      emitGameEvent(game.id, 'game:turn-warning', {
        gameId: game.id,
        userId: activePlayer.userId,
        secondsRemaining: remaining,
      });
    }

    // 3) Garbage-collect warned entries that are >2x timeout old.
    //    Prevents unbounded growth if hands get cancelled mid-warning.
    const gcCutoff = nowMs - 2 * TURN_TIMEOUT_MS;
    for (const [key, ts] of warnedTurns) {
      if (ts < gcCutoff) warnedTurns.delete(key);
    }
  } catch (error) {
    logger.error('Turn timer check failed', { error: (error as Error).message });
  }
}

setInterval(checkExpiredTurns, TURN_TICK_MS);
logger.info('Turn timer enabled', {
  timeoutMs: TURN_TIMEOUT_MS,
  warningMs: TURN_WARNING_MS,
  tickMs: TURN_TICK_MS,
});
