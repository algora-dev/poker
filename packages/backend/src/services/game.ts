import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { recordHandEvent } from './handLedger';
import { acquireUserMoneyMutex } from './userMoneyMutex';
import { checkActiveGameLock } from './activeGameLock';

/**
 * Phase 10 [H-04] hardening: error class shared by createGame and joinGame
 * so the API layer can map it to a stable HTTP 409.
 *
 * Withdrawal raises its own ActiveGameMoneyLockedError defined in
 * withdrawal.ts; both share the same `code` and 409 mapping convention.
 */
export class GameJoinMoneyLockedError extends Error {
  readonly code = 'active_game_money_locked' as const;
  readonly gameId: string;
  readonly gameStatus: 'waiting' | 'in_progress';
  constructor(gameId: string, gameStatus: 'waiting' | 'in_progress', message?: string) {
    super(
      message ??
        'Cannot join or create a table while already seated at an active or waiting table.'
    );
    this.gameId = gameId;
    this.gameStatus = gameStatus;
  }
}

/**
 * Hard cap on table size for the alpha. Per Phase 6 [M-03] and Gerald audit:
 * 9-handed UX/turn logic has not been deliberately tested; reject creation
 * attempts above this cap server-side regardless of client-side intent.
 */
export const MAX_TABLE_SIZE = 8;

/**
 * Create a new game
 */
export async function createGame(
  userId: string,
  name: string,
  minBuyIn: bigint,
  maxBuyIn: bigint,
  smallBlind: bigint,
  bigBlind: bigint,
  creatorBuyIn?: bigint,
  // Phase 6 [M-03][M-04]: optional max table size (clamped to MAX_TABLE_SIZE)
  // and explicit auto-start opt-in (default false). Hosts must opt in.
  options?: { maxPlayers?: number; autoStart?: boolean }
) {
  // Validate maxPlayers up-front so we never persist an invalid table size.
  const requestedMax = options?.maxPlayers ?? MAX_TABLE_SIZE;
  if (!Number.isInteger(requestedMax) || requestedMax < 2) {
    throw new Error('maxPlayers must be an integer >= 2');
  }
  if (requestedMax > MAX_TABLE_SIZE) {
    throw new Error(`maxPlayers cannot exceed ${MAX_TABLE_SIZE}`);
  }
  const autoStart = options?.autoStart === true;
  const buyIn = creatorBuyIn || minBuyIn;
  if (buyIn < minBuyIn || buyIn > maxBuyIn) {
    throw new Error('Creator buy-in must be within the min/max range');
  }
  // Validate buy-in range
  if (minBuyIn <= 0) {
    throw new Error('Minimum buy-in must be greater than 0');
  }
  if (maxBuyIn < minBuyIn) {
    throw new Error('Maximum buy-in must be >= minimum buy-in');
  }

  return await prisma.$transaction(async (tx) => {
    // Phase 10 [H-04] hardening: serialize all money movement for this
    // user. Blocks any concurrent withdraw / join / deposit-credit until
    // this tx commits.
    await acquireUserMoneyMutex(tx, userId);

    // Hard rule: a user with an existing seat at any waiting/in_progress
    // game cannot start a new one. They must leave the table first.
    const existingLock = await checkActiveGameLock(tx as any, userId);
    if (existingLock) {
      throw new GameJoinMoneyLockedError(
        existingLock.gameId,
        existingLock.status,
        'Cannot create a new table while already seated at an active or waiting table.'
      );
    }

    // Get user's chip balance
    const chipBalance = await tx.chipBalance.findUnique({
      where: { userId },
    });

    if (!chipBalance) {
      throw new Error('User has no chip balance');
    }

    // Note: Creator doesn't pay yet - will choose buy-in when starting game
    // Just validate they CAN afford minimum
    if (chipBalance.chips < buyIn) {
      throw new Error(
        `Insufficient chips. You have ${chipBalance.chips.toString()}, need ${buyIn.toString()}`
      );
    }

    // Create the game
    const game = await tx.game.create({
      data: {
        name,
        createdBy: userId,
        smallBlind,
        bigBlind,
        // Phase 6 [M-03]: hard-capped at MAX_TABLE_SIZE (8) above.
        maxPlayers: requestedMax,
        // Phase 6 [M-04]: opt-in auto-start. Default off.
        autoStart,
        minBuyIn,
        maxBuyIn,
        status: 'waiting',
      },
    });

    // Deduct creator's chosen buy-in and add them as first player
    await tx.chipBalance.update({
      where: { userId },
      data: { chips: { decrement: buyIn } },
    });

    await tx.gamePlayer.create({
      data: {
        gameId: game.id,
        userId,
        seatIndex: 0,
        chipStack: buyIn,
        position: 'waiting',
      },
    });

    await tx.chipAudit.create({
      data: {
        userId,
        operation: 'game_join',
        amountDelta: -buyIn,
        balanceBefore: chipBalance.chips,
        balanceAfter: chipBalance.chips - buyIn,
        reference: game.id,
        notes: `Created game: ${name}`,
      },
    });

    logger.info('Game created', {
      gameId: game.id,
      userId,
      minBuyIn: minBuyIn.toString(),
      maxBuyIn: maxBuyIn.toString(),
    });

    // Phase 7 [M-05]: ledger event for game lifecycle.
    await recordHandEvent(tx, {
      gameId: game.id,
      userId,
      eventType: 'game_created',
      payload: {
        name,
        minBuyIn: minBuyIn.toString(),
        maxBuyIn: maxBuyIn.toString(),
        smallBlind: smallBlind.toString(),
        bigBlind: bigBlind.toString(),
        maxPlayers: requestedMax,
        autoStart,
      },
    });
    await recordHandEvent(tx, {
      gameId: game.id,
      userId,
      eventType: 'player_joined',
      payload: {
        seatIndex: 0,
        buyIn: buyIn.toString(),
      },
    });

    return {
      game,
      newBalance: (chipBalance.chips - buyIn).toString(),
    };
  });
}

/**
 * Get game by ID with players
 */
export async function getGame(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      players: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              pfpUrl: true,
            },
          },
        },
      },
    },
  });

  if (!game) {
    throw new Error('Game not found');
  }

  return game;
}

/**
 * Get all active games (waiting or in_progress)
 */
export async function getActiveGames() {
  return await prisma.game.findMany({
    where: {
      status: {
        in: ['waiting', 'in_progress'],
      },
    },
    include: {
      players: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

/**
 * Get completed games for history
 */
export async function getCompletedGames(limit: number = 20) {
  return await prisma.game.findMany({
    where: {
      status: { in: ['completed', 'cancelled'] },
    },
    include: {
      players: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      },
      hands: {
        select: { id: true },
      },
    },
    orderBy: {
      completedAt: 'desc',
    },
    take: limit,
  });
}

/**
 * Cancel a game before it starts
 * Only creator can cancel, only if status is "waiting"
 */
export async function cancelGameBeforeStart(userId: string, gameId: string) {
  return await prisma.$transaction(async (tx) => {
    const game = await tx.game.findUnique({
      where: { id: gameId },
      include: {
        players: true,
      },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    // Only creator can cancel
    if (game.createdBy !== userId) {
      throw new Error('Only the game creator can cancel');
    }

    // Can only cancel if still waiting
    if (game.status !== 'waiting') {
      throw new Error('Cannot cancel - game already started');
    }

    // Can only cancel if only 1 player (creator)
    if (game.players.length > 1) {
      throw new Error('Cannot cancel - other players have joined');
    }

    const creator = game.players[0];
    if (!creator) {
      throw new Error('No players found in game');
    }

    // Phase 10 [H-01]: route through canonical closeGame helper.
    const { closeGameInTx } = await import('./closeGame');
    const closed = await closeGameInTx(tx, {
      gameId,
      reason: 'pre_start_cancel',
      notes: `Cancelled game before start: ${game.name}`,
    });

    const refunded = closed.refundedPlayers[0];
    logger.info('Game cancelled by creator', {
      gameId,
      userId,
      refundAmount: refunded?.refundAmount.toString() ?? '0',
    });

    return {
      success: true,
      refundAmount: (refunded?.refundAmount ?? 0n).toString(),
      newBalance: (refunded?.newBalance ?? 0n).toString(),
    };
  });
}

/**
 * Join an existing game
 */
export async function joinGame(userId: string, gameId: string, buyInAmount?: bigint) {
  return await prisma.$transaction(async (tx) => {
    // Phase 10 [H-04] hardening: serialize money movement and reject join
    // if user is already seated at any other waiting/in_progress game.
    await acquireUserMoneyMutex(tx, userId);

    const otherSeatLock = await checkActiveGameLock(tx as any, userId);
    // Allow joining the SAME game (idempotency / re-join after refresh).
    if (otherSeatLock && otherSeatLock.gameId !== gameId) {
      throw new GameJoinMoneyLockedError(
        otherSeatLock.gameId,
        otherSeatLock.status,
        'Cannot join this table while still seated at another active or waiting table.'
      );
    }

    // Get game with players
    const game = await tx.game.findUnique({
      where: { id: gameId },
      include: {
        players: true,
      },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== 'waiting') {
      throw new Error('Game is not accepting players');
    }

    // Check if user already in game
    const alreadyJoined = game.players.find((p) => p.userId === userId);
    if (alreadyJoined) {
      throw new Error('You are already in this game');
    }

    // Check if game is full
    if (game.players.length >= game.maxPlayers) {
      throw new Error('Game is full');
    }

    // Use chosen amount, or default to minBuyIn
    const buyIn = buyInAmount || game.minBuyIn;

    // Validate buy-in within range
    if (buyIn < game.minBuyIn || buyIn > game.maxBuyIn) {
      throw new Error(
        `Buy-in must be between ${(Number(game.minBuyIn) / 1_000_000).toFixed(2)} and ${(Number(game.maxBuyIn) / 1_000_000).toFixed(2)} chips`
      );
    }

    // Get user's chip balance
    const chipBalance = await tx.chipBalance.findUnique({
      where: { userId },
    });

    if (!chipBalance) {
      throw new Error('User has no chip balance');
    }

    // Check if user has enough chips
    if (chipBalance.chips < buyIn) {
      throw new Error(
        `Insufficient chips. You have ${chipBalance.chips.toString()}, need ${buyIn.toString()}`
      );
    }

    // Deduct buy-in from user's balance
    const updatedBalance = await tx.chipBalance.update({
      where: { userId },
      data: {
        chips: {
          decrement: buyIn,
        },
      },
    });

    // Add player to game
    await tx.gamePlayer.create({
      data: {
        gameId: game.id,
        userId,
        seatIndex: game.players.length, // Next available seat
        chipStack: buyIn,
        position: 'waiting', // Waiting for game to start
      },
    });

    // DON'T auto-start - keep in "waiting" status
    // Game will start when creator clicks "Start Game" button
    const updatedGame = game;

    // Create chip audit log
    await tx.chipAudit.create({
      data: {
        userId,
        operation: 'game_join',
        amountDelta: -buyIn,
        balanceBefore: chipBalance.chips,
        balanceAfter: updatedBalance.chips,
        reference: game.id,
        notes: `Joined game: ${game.name}`,
      },
    });

    logger.info('Player joined game', {
      gameId: game.id,
      userId,
      buyIn: buyIn.toString(),
      newBalance: updatedBalance.chips.toString(),
    });

    // Phase 7 [M-05]: ledger event for join.
    await recordHandEvent(tx, {
      gameId: game.id,
      userId,
      eventType: 'player_joined',
      payload: {
        seatIndex: game.players.length,
        buyIn: buyIn.toString(),
      },
    });

    return {
      game: updatedGame,
      newBalance: updatedBalance.chips.toString(),
    };
  });
}

/**
 * Result of a leaveGame call.
 *
 * `mode` documents which path ran:
 *   - 'waiting_refund'   - game was waiting; seat removed, chips returned
 *                          to off-table balance.
 *   - 'in_progress_fold' - game is live; player is marked folded for the
 *                          current hand and 'eliminated' for next hands,
 *                          but they remain seated until closeGame runs
 *                          (chip-conservation: their remaining stack +
 *                          any in-pot contributions are refunded when the
 *                          game closes).
 *   - 'closed_last_player' - the leaver was the last player at a waiting
 *                          game; the game was auto-cancelled via the
 *                          canonical closeGame path.
 *   - 'idempotent_noop'  - the user wasn't seated at this game. Returned
 *                          (not thrown) so the UI 'leave' button is safe
 *                          to click twice.
 */
export interface LeaveGameResult {
  mode:
    | 'waiting_refund'
    | 'in_progress_fold'
    | 'closed_last_player'
    | 'idempotent_noop';
  gameId: string;
  userId: string;
  refundAmount?: string;
  newBalance?: string;
  gameStatusAfter: string;
}

/**
 * Leave a game.
 *
 * Two real paths plus two no-ops:
 *
 *   1. status='waiting' and user is the LAST seated player
 *      -> closeGame(reason='pre_start_cancel') refunds them + cancels the
 *         game in one atomic transaction. Money-mutex + ChipAudit +
 *         MoneyEvent all handled by closeGameInTx.
 *
 *   2. status='waiting' and other players remain
 *      -> refund player's chipStack to off-table balance, delete their
 *         GamePlayer row, write ChipAudit + MoneyEvent. Game stays open.
 *         Remaining players keep their (now sparse) seatIndex values
 *         unchanged so the front-end seat rendering (already fixed to
 *         handle sparse seats post-2026-05-11) is correct.
 *
 *   3. status='in_progress'
 *      -> Do NOT refund here. The player's chips are committed to the
 *         current hand and possibly subsequent ones (active-game lock
 *         H-04). Instead: mark the GamePlayer row position='folded' so
 *         turnTimer auto-folds them, and set a 'leftAt' marker so the
 *         next-hand dealer skips them. The closeGame path at game end
 *         refunds whatever stack remains plus any open-pot share. This
 *         keeps the active-game lock invariant intact (the user stays
 *         seated until game close) AND lets the player walk away from
 *         the UI.
 *
 *   4. user was never seated
 *      -> idempotent_noop. Safe to call from a stale UI.
 *
 * NOTE on path 3 "mark folded": if it is currently this player's turn,
 * we ALSO want the turn to advance. The turnTimer (every 2s) will do
 * this naturally once it sees position='folded' on the active seat
 * (it skips folded/all_in/eliminated when picking next), but to make
 * the table feel responsive we also invoke processAction(... 'fold')
 * inline when applicable. If that race-loses to a concurrent action
 * we ignore the error (the position update is already enough).
 */
export async function leaveGame(
  userId: string,
  gameId: string
): Promise<LeaveGameResult> {
  // We do the read + branch outside the main transaction so we can call
  // closeGameInTx (which has its own composition rules) without nesting
  // a tx-in-tx. closeGameInTx is itself transactional via the parent
  // tx we pass in.
  return await prisma.$transaction(async (tx) => {
    await acquireUserMoneyMutex(tx, userId);

    const game = await tx.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (!game) {
      // Idempotent: pretend we already left. UI doesn't need to error.
      return {
        mode: 'idempotent_noop' as const,
        gameId,
        userId,
        gameStatusAfter: 'unknown',
      };
    }

    const seat = game.players.find((p) => p.userId === userId);
    if (!seat) {
      return {
        mode: 'idempotent_noop' as const,
        gameId,
        userId,
        gameStatusAfter: game.status,
      };
    }

    // Path 1+2: waiting game. Refund the player.
    if (game.status === 'waiting') {
      const remainingPlayers = game.players.filter(
        (p) => p.userId !== userId
      );

      // Last player out -> cancel the whole game via closeGame.
      if (remainingPlayers.length === 0) {
        const { closeGameInTx } = await import('./closeGame');
        const result = await closeGameInTx(tx, {
          gameId,
          reason: 'pre_start_cancel',
          notes: 'last seated player left',
        });
        const me = result.refundedPlayers.find((r) => r.userId === userId);
        return {
          mode: 'closed_last_player' as const,
          gameId,
          userId,
          refundAmount: me?.refundAmount?.toString() ?? '0',
          newBalance: me?.newBalance?.toString(),
          gameStatusAfter: 'cancelled',
        };
      }

      // Other players remain -> single-player refund + seat removal.
      const stack = BigInt(seat.chipStack ?? 0n);
      const balanceBeforeRow = await tx.chipBalance.findUnique({
        where: { userId },
      });
      if (!balanceBeforeRow) {
        throw new Error(
          `leaveGame: missing ChipBalance for user ${userId} (game ${gameId})`
        );
      }
      const balanceAfterRow = stack > 0n
        ? await tx.chipBalance.update({
            where: { userId },
            data: { chips: { increment: stack } },
          })
        : balanceBeforeRow;

      // Audit + ledger.
      await tx.chipAudit.create({
        data: {
          userId,
          operation: 'game_leave_refund',
          amountDelta: stack,
          balanceBefore: balanceBeforeRow.chips,
          balanceAfter: balanceAfterRow.chips,
          reference: gameId,
          notes: `Left waiting game ${game.name}`,
        },
      });
      const { recordMoneyEvent } = await import('./moneyLedger');
      await recordMoneyEvent(tx, {
        userId,
        eventType: 'game_cashout',
        amount: stack,
        balanceBefore: balanceBeforeRow.chips,
        balanceAfter: balanceAfterRow.chips,
        gameId,
        handId: null,
        correlationId: `leave:${gameId}:${userId}`,
        payload: { mode: 'waiting_refund' },
      });

      // Zero the stack and remove the seat. We delete the row (not just
      // zero) because the player is gone and joinGame() rejects users
      // who already have a row at this game.
      await tx.gamePlayer.delete({ where: { id: seat.id } });

      await recordHandEvent(tx, {
        gameId,
        userId,
        eventType: 'player_left',
        payload: {
          mode: 'waiting_refund',
          refundAmount: stack.toString(),
          remainingSeats: remainingPlayers.length,
        },
      });

      logger.info('Player left waiting game', {
        gameId,
        userId,
        refund: stack.toString(),
        remaining: remainingPlayers.length,
      });

      return {
        mode: 'waiting_refund' as const,
        gameId,
        userId,
        refundAmount: stack.toString(),
        newBalance: balanceAfterRow.chips.toString(),
        gameStatusAfter: 'waiting',
      };
    }

    // Path 3: in_progress. Mark folded; do not refund here. Refund happens
    // when closeGame runs at natural completion.
    if (game.status === 'in_progress') {
      // Use position='folded' for the rest of THIS hand and 'eliminated'
      // semantics for future hands: simplest is to flip to 'folded' and
      // let the turnTimer skip them; the next-hand init also skips folded
      // seats unless explicitly reset. We piggy-back on the existing
      // 'eliminated' position for permanent skip.
      //
      // We must not free their chip mass here — active-game lock H-04
      // requires they stay seated until closeGame runs.
      await tx.gamePlayer.update({
        where: { id: seat.id },
        data: { position: 'eliminated' },
      });

      await recordHandEvent(tx, {
        gameId,
        userId,
        eventType: 'player_left',
        payload: {
          mode: 'in_progress_fold',
          stackAtLeave: BigInt(seat.chipStack ?? 0n).toString(),
          willRefundOnGameClose: true,
        },
      });

      logger.info('Player left in-progress game (will refund at close)', {
        gameId,
        userId,
        stack: BigInt(seat.chipStack ?? 0n).toString(),
      });

      return {
        mode: 'in_progress_fold' as const,
        gameId,
        userId,
        gameStatusAfter: 'in_progress',
      };
    }

    // Game is completed/cancelled — nothing to do.
    return {
      mode: 'idempotent_noop' as const,
      gameId,
      userId,
      gameStatusAfter: game.status,
    };
  });
}
