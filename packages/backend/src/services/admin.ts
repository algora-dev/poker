import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Clean up abandoned/stuck games and refund chips
 * - Games stuck in "in_progress" for > 1 hour
 * - Games in "waiting" for > 24 hours
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
        startedAt: {
          lt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
        },
      },
      include: {
        players: {
          include: {
            user: {
              select: { id: true, username: true },
            },
          },
        },
        hands: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    // Find abandoned waiting games (> 24 hours old)
    // Include `hands` (will be empty) so the union with stuckInProgressGames
    // keeps a consistent type and TS does not narrow `hands` away.
    const abandonedWaitingGames = await tx.game.findMany({
      where: {
        status: 'waiting',
        createdAt: {
          lt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
        },
      },
      include: {
        players: {
          include: {
            user: {
              select: { id: true, username: true },
            },
          },
        },
        hands: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const allGamesToCleanup = [...stuckInProgressGames, ...abandonedWaitingGames];

    for (const game of allGamesToCleanup) {
      logger.info('Cleaning up stuck game', {
        gameId: game.id,
        name: game.name,
        status: game.status,
        players: game.players.length,
      });

      // Check if any hands were played (actions taken)
      const handActions = game.hands[0]
        ? await tx.handAction.count({
            where: { handId: game.hands[0].id },
          })
        : 0;

      // Refund policy:
      // - If NO actions taken → Full refund
      // - If actions taken → Split pot equally
      const shouldFullRefund = handActions === 0;

      for (const player of game.players) {
        let refundAmount: bigint;

        if (shouldFullRefund) {
          // Full buy-in refund
          refundAmount = player.chipStack;
        } else {
          // Split pot equally (fair for stuck games)
          const totalPot =
            game.hands[0]?.pot || game.players.reduce((sum, p) => sum + (game.minBuyIn - p.chipStack), BigInt(0));
          refundAmount = totalPot / BigInt(game.players.length);
        }

        if (refundAmount > 0) {
          // Get current chip balance
          const chipBalance = await tx.chipBalance.findUnique({
            where: { userId: player.userId },
          });

          if (chipBalance) {
            // Refund chips
            const newBalance = await tx.chipBalance.update({
              where: { userId: player.userId },
              data: {
                chips: {
                  increment: refundAmount,
                },
              },
            });

            // Audit log
            await tx.chipAudit.create({
              data: {
                userId: player.userId,
                operation: 'game_refund',
                amountDelta: refundAmount,
                balanceBefore: chipBalance.chips,
                balanceAfter: newBalance.chips,
                reference: game.id,
                notes: `Refund from abandoned game: ${game.name} (${shouldFullRefund ? 'full' : 'split'})`,
              },
            });

            results.chipsRefunded += refundAmount;
            results.playersRefunded++;

            logger.info('Player refunded', {
              userId: player.userId,
              username: player.user.username,
              amount: refundAmount.toString(),
              type: shouldFullRefund ? 'full' : 'split',
            });
          }
        }
      }

      // Mark game as cancelled
      await tx.game.update({
        where: { id: game.id },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
        },
      });

      results.gamesMarkedCancelled++;
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
 * Cancel a specific game and refund players
 * (Admin function)
 */
export async function cancelGame(gameId: string, reason: string) {
  return await prisma.$transaction(async (tx) => {
    const game = await tx.game.findUnique({
      where: { id: gameId },
      include: {
        players: {
          include: {
            user: {
              select: { id: true, username: true },
            },
          },
        },
        hands: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status === 'completed' || game.status === 'cancelled') {
      throw new Error('Game already finished');
    }

    // Check if any hands were played
    const handActions = game.hands[0]
      ? await tx.handAction.count({
          where: { handId: game.hands[0].id },
        })
      : 0;

    const shouldFullRefund = handActions === 0;

    // Refund all players
    for (const player of game.players) {
      let refundAmount: bigint;

      if (shouldFullRefund) {
        refundAmount = player.chipStack;
      } else {
        const totalPot =
          game.hands[0]?.pot || game.players.reduce((sum, p) => sum + (game.minBuyIn - p.chipStack), BigInt(0));
        refundAmount = totalPot / BigInt(game.players.length);
      }

      if (refundAmount > 0) {
        const chipBalance = await tx.chipBalance.findUnique({
          where: { userId: player.userId },
        });

        if (chipBalance) {
          const newBalance = await tx.chipBalance.update({
            where: { userId: player.userId },
            data: {
              chips: {
                increment: refundAmount,
              },
            },
          });

          await tx.chipAudit.create({
            data: {
              userId: player.userId,
              operation: 'game_refund',
              amountDelta: refundAmount,
              balanceBefore: chipBalance.chips,
              balanceAfter: newBalance.chips,
              reference: gameId,
              notes: `Admin cancelled game: ${reason}`,
            },
          });
        }
      }
    }

    // Mark as cancelled
    await tx.game.update({
      where: { id: gameId },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    logger.info('Game cancelled by admin', {
      gameId,
      reason,
      playersRefunded: game.players.length,
    });

    return { success: true, playersRefunded: game.players.length };
  });
}
