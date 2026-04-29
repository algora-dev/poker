import { prisma } from '../db/client';
import { processAction } from '../services/pokerActions';
import { emitGameEvent } from '../socket';
import { logger } from '../utils/logger';

const TURN_TIMEOUT_MS = 20_000; // 20 seconds total
const WARNING_AT_MS = 10_000;   // Warning fires at 10 seconds (10s remaining)

/**
 * Check for expired turns and auto-act.
 * Runs every 2 seconds.
 */
async function checkExpiredTurns() {
  try {
    const now = new Date();

    // Find hands where turn has expired (>15 seconds)
    const expiredHands = await prisma.hand.findMany({
      where: {
        stage: { notIn: ['completed', 'showdown'] },
        turnStartedAt: {
          lt: new Date(now.getTime() - TURN_TIMEOUT_MS),
        },
      },
      include: {
        game: {
          include: {
            players: {
              orderBy: { seatIndex: 'asc' },
            },
          },
        },
      },
    });

    for (const hand of expiredHands) {
      const game = hand.game;
      if (game.status !== 'in_progress') continue;

      const activePlayer = game.players[hand.activePlayerIndex];
      if (!activePlayer) continue;
      if (activePlayer.position === 'folded' || activePlayer.position === 'eliminated' || activePlayer.position === 'all_in') continue;

      // Check if player already acted this turn (race condition with slow DB commits)
      const recentAction = await prisma.handAction.findFirst({
        where: {
          handId: hand.id,
          userId: activePlayer.userId,
          stage: hand.stage,
          action: { not: 'blind' },
          timestamp: { gt: hand.turnStartedAt || new Date(0) },
        },
      });
      if (recentAction) {
        logger.info('Timer: player already acted, skipping', { userId: activePlayer.userId.slice(-6) });
        continue;
      }

      // Auto-action: check if possible, otherwise fold
      const hasActiveBet = hand.currentBet > BigInt(0);

      // Calculate if player owes anything
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

      const autoAction = owes > BigInt(0) ? 'fold' : 'check';

      logger.info('Turn timer expired — auto-acting', {
        gameId: game.id,
        handId: hand.id,
        userId: activePlayer.userId,
        username: activePlayer.userId,
        action: autoAction,
        turnDuration: now.getTime() - (hand.turnStartedAt?.getTime() || 0),
      });

      try {
        await processAction(game.id, activePlayer.userId, autoAction as any);
        emitGameEvent(game.id, 'game:updated', {
          gameId: game.id,
          action: autoAction,
          userId: activePlayer.userId,
          autoAction: true,
        });
      } catch (err) {
        logger.error('Auto-action failed', { gameId: game.id, error: err });
      }
    }

    // Find hands entering warning zone (10-15 seconds) and emit warning
    const warningHands = await prisma.hand.findMany({
      where: {
        stage: { notIn: ['completed', 'showdown'] },
        turnStartedAt: {
          lt: new Date(now.getTime() - WARNING_AT_MS),
          gt: new Date(now.getTime() - TURN_TIMEOUT_MS),
        },
      },
      include: {
        game: {
          include: {
            players: {
              orderBy: { seatIndex: 'asc' },
            },
          },
        },
      },
    });

    for (const hand of warningHands) {
      const game = hand.game;
      if (game.status !== 'in_progress') continue;
      const activePlayer = game.players[hand.activePlayerIndex];
      if (!activePlayer) continue;

      const elapsed = now.getTime() - (hand.turnStartedAt?.getTime() || 0);
      const remaining = Math.max(0, Math.ceil((TURN_TIMEOUT_MS - elapsed) / 1000));

      emitGameEvent(game.id, 'game:turn-warning', {
        gameId: game.id,
        userId: activePlayer.userId,
        secondsRemaining: remaining,
      });
    }
  } catch (error) {
    logger.error('Turn timer check failed', { error });
  }
}

// Run every 2 seconds
setInterval(checkExpiredTurns, 2000);

logger.info('Turn timer job initialized (checks every 2s)');
