import { prisma } from '../db/client';
import { atomicStartGame } from '../services/holdemGame';
import { closeGame } from '../services/closeGame';
import { emitGameEvent } from '../socket';
import { logger } from '../utils/logger';

/**
 * Auto-start games that have been waiting for 2 minutes
 */
export async function autoStartWaitingGames() {
  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    // Phase 6 [M-04]: opt-in auto-start. Hosts must explicitly set autoStart
    // when creating the game. Default off so a host running a money table
    // is not surprised by the cron starting their game.
    const waitingGames = await prisma.game.findMany({
      where: {
        status: 'waiting',
        autoStart: true,
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

      // PHASE 5 [H-05]: atomic auto-start via atomicStartGame helper. Status
      // flip + first-hand init in ONE transaction. Status guard makes manual
      // start + auto-start mutually exclusive (loser gets already_started).
      const result = await atomicStartGame(game.id);
      if (result.ok !== true) {
        if (result.code === 'already_started') {
          logger.info('Auto-start skipped (lost race or already started)', {
            gameId: game.id,
          });
        } else {
          logger.error('Auto-start failed; rolled back', {
            gameId: game.id,
            error: result.message,
          });
        }
        continue;
      }

      // Emit game started event after the atomic commit.
      emitGameEvent(game.id, 'game:started', {
        gameId: game.id,
        playerCount: game.players.length,
        autoStarted: true,
      });

      logger.info('Game auto-started successfully (atomic)', {
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

      // If idle for > 120 seconds with no active hand, force close.
      // (must be longer than 25s between-hand countdown + buffer)
      // Phase 10 [H-01]: route through the canonical closeGame helper
      // so refunds are transactional, audited, and zero the table stack.
      if (idleMs > 120_000) {
        try {
          const result = await closeGame({
            gameId: game.id,
            reason: 'stale_cleanup',
            notes: `Stale-game cleanup after ${Math.round(idleMs / 1000)}s idle`,
          });
          logger.info('Cleaned up stale game', {
            gameId: game.id,
            name: game.name,
            idleSeconds: Math.round(idleMs / 1000),
            refundedPlayers: result.refundedPlayers.length,
            totalRefunded: result.totalRefunded.toString(),
          });
        } catch (closeErr) {
          logger.error('Stale-game close failed', {
            gameId: game.id,
            error: (closeErr as Error).message,
          });
        }
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
        // Phase 10 [H-01]: same canonical close path so the lone creator's
        // buy-in is refunded transactionally with full audit trail.
        try {
          const result = await closeGame({
            gameId: game.id,
            reason: 'stale_cleanup',
            notes: 'Stale waiting game (≤1 player) auto-cancelled',
          });
          logger.info('Cancelled stale waiting game', {
            gameId: game.id,
            name: game.name,
            refundedPlayers: result.refundedPlayers.length,
            totalRefunded: result.totalRefunded.toString(),
          });
        } catch (closeErr) {
          logger.error('Stale waiting close failed', {
            gameId: game.id,
            error: (closeErr as Error).message,
          });
        }
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
