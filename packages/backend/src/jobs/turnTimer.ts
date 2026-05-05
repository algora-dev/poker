// Turn timer: auto-acts when a player's turn expires (check if free, else fold).
// Re-enabled now that betting completion, all-in handling, and min-raise are stable.
//
// Tunables (env): TURN_TIMEOUT_MS, TURN_WARNING_MS, TURN_TICK_MS

import { prisma } from '../db/client';
import { processAction } from '../services/pokerActions';
import { emitGameEvent } from '../socket';
import { logger } from '../utils/logger';

const TURN_TIMEOUT_MS = parseInt(process.env.TURN_TIMEOUT_MS || '30000', 10); // 30s default
const TURN_WARNING_MS = parseInt(process.env.TURN_WARNING_MS || '10000', 10); // warn at 10s remaining
const TURN_TICK_MS    = parseInt(process.env.TURN_TICK_MS    || '2000',  10);

// Track hands we've already warned for, so the warning fires once per turn
// instead of every tick during the warning window.
// Key: `${handId}:${activePlayerIndex}`. Cleaned when the turn changes.
const warnedTurns = new Map<string, number>(); // value = timestamp warned

function turnKey(handId: string, idx: number) {
  return `${handId}:${idx}`;
}

async function checkExpiredTurns() {
  const now = new Date();
  const nowMs = now.getTime();

  try {
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
        // Clear any warning state for this turn since it's over.
        warnedTurns.delete(turnKey(hand.id, hand.activePlayerIndex));
      } catch (err) {
        // processAction can throw if the hand state changed mid-tick; safe to retry next tick.
        logger.error('Auto-action failed (will retry next tick)', { gameId: game.id, error: (err as Error).message });
      }
    }

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
