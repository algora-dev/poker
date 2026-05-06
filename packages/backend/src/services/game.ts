import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { recordHandEvent } from './handLedger';

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

    // Refund buy-in to creator
    const chipBalance = await tx.chipBalance.findUnique({
      where: { userId: creator.userId },
    });

    if (!chipBalance) {
      throw new Error('Chip balance not found');
    }

    const refundAmount = creator.chipStack;

    const newBalance = await tx.chipBalance.update({
      where: { userId: creator.userId },
      data: {
        chips: {
          increment: refundAmount,
        },
      },
    });

    // Audit log
    await tx.chipAudit.create({
      data: {
        userId: creator.userId,
        operation: 'game_refund',
        amountDelta: refundAmount,
        balanceBefore: chipBalance.chips,
        balanceAfter: newBalance.chips,
        reference: gameId,
        notes: `Cancelled game before start: ${game.name}`,
      },
    });

    // Mark game as cancelled
    await tx.game.update({
      where: { id: gameId },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    logger.info('Game cancelled by creator', {
      gameId,
      userId,
      refundAmount: refundAmount.toString(),
    });

    return {
      success: true,
      refundAmount: refundAmount.toString(),
      newBalance: newBalance.chips.toString(),
    };
  });
}

/**
 * Join an existing game
 */
export async function joinGame(userId: string, gameId: string, buyInAmount?: bigint) {
  return await prisma.$transaction(async (tx) => {
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
