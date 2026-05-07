import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { closeGameInTx } from './closeGame';

/**
 * Clean up abandoned/stuck games and refund chips.
 *
 * Phase 10 [H-01]: this and the manual `cancelGame` below now both route
 * through the canonical `closeGameInTx` helper so refunds are
 * transactional, audited, and zero the table stack. The old "split pot
 * equally if any actions were taken" heuristic was a chip-leak vector
 * (see audits/t3-poker/11-harness-findings.md) and has been retired.
 */
export async function cleanupStuckGames() {
  const results = {
    gamesMarkedCancelled: 0,
    chipsRefunded: BigInt(0),
    playersRefunded: 0,
  };

  return await prisma.$transaction(async (tx) => {
    // Find stuck in-progress games (> 10 minutes old)
    const stuckInProgressGames = await tx.game.findMany({
      where: {
        status: 'in_progress',
        startedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
      },
      select: { id: true, name: true, status: true },
    });

    // Find abandoned waiting games (> 24 hours old)
    const abandonedWaitingGames = await tx.game.findMany({
      where: {
        status: 'waiting',
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      select: { id: true, name: true, status: true },
    });

    const allGamesToCleanup = [...stuckInProgressGames, ...abandonedWaitingGames];

    for (const game of allGamesToCleanup) {
      logger.info('Cleaning up stuck game', {
        gameId: game.id,
        name: game.name,
        status: game.status,
      });

      const closed = await closeGameInTx(tx, {
        gameId: game.id,
        reason: 'admin_cancel',
        notes: `Admin cleanup of stuck ${game.status} game: ${game.name}`,
      });

      results.gamesMarkedCancelled++;
      results.chipsRefunded += closed.totalRefunded;
      results.playersRefunded += closed.refundedPlayers.length;
      for (const r of closed.refundedPlayers) {
        logger.info('Player refunded', {
          userId: r.userId,
          amount: r.refundAmount.toString(),
          newBalance: r.newBalance.toString(),
        });
      }
    }

    logger.info('Cleanup complete', {
      gamesMarkedCancelled: results.gamesMarkedCancelled,
      chipsRefunded: results.chipsRefunded.toString(),
      playersRefunded: results.playersRefunded,
    });

    return {
      ...results,
      chipsRefunded: results.chipsRefunded.toString(),
    };
  });
}

/**
 * Cancel a specific game and refund players (admin function).
 * Phase 10 [H-01]: routes through closeGameInTx.
 */
export async function cancelGame(gameId: string, reason: string) {
  return await prisma.$transaction(async (tx) => {
    const game = await tx.game.findUnique({
      where: { id: gameId },
      select: { id: true, status: true, name: true },
    });
    if (!game) throw new Error('Game not found');
    if (game.status === 'completed' || game.status === 'cancelled') {
      throw new Error('Game already finished');
    }

    const closed = await closeGameInTx(tx, {
      gameId,
      reason: 'admin_cancel',
      notes: `Admin cancelled game: ${reason}`,
    });

    logger.info('Game cancelled by admin', {
      gameId,
      reason,
      refundedPlayers: closed.refundedPlayers.length,
      totalRefunded: closed.totalRefunded.toString(),
    });

    return {
      success: true,
      playersRefunded: closed.refundedPlayers.length,
      totalRefunded: closed.totalRefunded.toString(),
    };
  });
}
