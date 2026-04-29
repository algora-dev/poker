import { prisma } from '../db/client';
import { initializeHand } from '../services/holdemGame';
import { emitGameEvent } from '../socket';
import { logger } from '../utils/logger';

/**
 * Auto-start games that have been waiting for 2 minutes
 */
export async function autoStartWaitingGames() {
  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    // Find games waiting for > 2 minutes with at least 2 players
    const waitingGames = await prisma.game.findMany({
      where: {
        status: 'waiting',
        createdAt: {
          lt: twoMinutesAgo,
        },
      },
      include: {
        players: true,
      },
    });

    for (const game of waitingGames) {
      // Need at least 2 players
      if (game.players.length < 2) {
        logger.info('Skipping auto-start - not enough players', {
          gameId: game.id,
          playerCount: game.players.length,
        });
        continue;
      }

      logger.info('Auto-starting game', {
        gameId: game.id,
        name: game.name,
        playerCount: game.players.length,
        waitedMinutes: (Date.now() - game.createdAt.getTime()) / 60000,
      });

      // Update game status
      await prisma.game.update({
        where: { id: game.id },
        data: {
          status: 'in_progress',
          startedAt: new Date(),
        },
      });

      // Initialize first hand
      await initializeHand(game.id);

      // Emit game started event
      emitGameEvent(game.id, 'game:started', {
        gameId: game.id,
        playerCount: game.players.length,
        autoStarted: true,
      });

      logger.info('Game auto-started successfully', {
        gameId: game.id,
        playerCount: game.players.length,
      });
    }
  } catch (error) {
    logger.error('Auto-start games job failed', { error });
  }
}

/**
 * Mark games as completed when no active hand and game is stale,
 * OR when the game has finished (all hands completed, no pending next hand).
 */
async function cleanupFinishedGames() {
  try {
    // Find in_progress games with no active (non-completed) hand
    const inProgressGames = await prisma.game.findMany({
      where: {
        status: 'in_progress',
      },
      include: {
        players: true,
        hands: {
          orderBy: { createdAt: 'desc' as const },
          take: 1,
        },
      },
    });

    for (const game of inProgressGames) {
      const latestHand = game.hands[0];
      const hasActiveHand = latestHand && latestHand.stage !== 'completed';
      
      // Even if there's an active hand, clean up if no action for 5+ minutes
      if (hasActiveHand && latestHand) {
        const handAge = Date.now() - new Date(latestHand.createdAt).getTime();
        if (handAge < 5 * 60 * 1000) continue; // Hand is less than 5 min old, still active
        // Hand is 5+ minutes old with no completion — stale, fall through to cleanup
        logger.info('Stale active hand detected', { gameId: game.id, handAge: Math.round(handAge/1000) });
      } else if (hasActiveHand) {
        continue;
      }

      // No active hand — check how long since last hand completed (or game started)
      const lastActivity = latestHand?.completedAt || latestHand?.createdAt || game.startedAt || game.createdAt;
      const idleMs = Date.now() - new Date(lastActivity).getTime();

      // If idle for > 120 seconds with no active hand, mark completed
      // (must be longer than 25s between-hand countdown + buffer)
      if (idleMs > 120_000) {
        // Refund remaining chips to players
        for (const player of game.players) {
          if (player.chipStack > BigInt(0)) {
            const balance = await prisma.chipBalance.findUnique({
              where: { userId: player.userId },
            });
            if (balance) {
              await prisma.chipBalance.update({
                where: { userId: player.userId },
                data: { chips: { increment: player.chipStack } },
              });
            }
          }
        }

        await prisma.game.update({
          where: { id: game.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });

        logger.info('Cleaned up stale game', {
          gameId: game.id,
          name: game.name,
          idleSeconds: Math.round(idleMs / 1000),
        });
      }
    }

    // Also clean up waiting games with no players for > 5 minutes
    const staleWaiting = await prisma.game.findMany({
      where: {
        status: 'waiting',
        createdAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
      },
      include: { players: true },
    });

    for (const game of staleWaiting) {
      if (game.players.length <= 1) {
        // Refund the creator if they're still there
        for (const player of game.players) {
          if (player.chipStack > BigInt(0)) {
            const balance = await prisma.chipBalance.findUnique({
              where: { userId: player.userId },
            });
            if (balance) {
              await prisma.chipBalance.update({
                where: { userId: player.userId },
                data: { chips: { increment: player.chipStack } },
              });
            }
          }
        }

        await prisma.game.update({
          where: { id: game.id },
          data: {
            status: 'cancelled',
            completedAt: new Date(),
          },
        });

        logger.info('Cancelled stale waiting game', {
          gameId: game.id,
          name: game.name,
        });
      }
    }
  } catch (error) {
    logger.error('Cleanup finished games failed', { error });
  }
}

// Run every 30 seconds
setInterval(async () => {
  await autoStartWaitingGames();
  await cleanupFinishedGames();
}, 30 * 1000);

logger.info('Auto-start + cleanup job initialized (checks every 30s)');
