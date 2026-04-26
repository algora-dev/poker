import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Simple card game: each player gets 1 card (1-13), highest wins
 */
export async function playSimpleGame(gameId: string) {
  return await prisma.$transaction(async (tx) => {
    // Get game with players
    const game = await tx.game.findUnique({
      where: { id: gameId },
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
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== 'in_progress') {
      throw new Error('Game is not in progress');
    }

    if (game.players.length !== 2) {
      throw new Error('Game must have exactly 2 players');
    }

    const player1 = game.players[0];
    const player2 = game.players[1];

    // Deal random cards (1-13, representing card values)
    const card1 = Math.floor(Math.random() * 13) + 1;
    const card2 = Math.floor(Math.random() * 13) + 1;

    logger.info('Cards dealt', {
      gameId,
      player1: { userId: player1.userId, card: card1 },
      player2: { userId: player2.userId, card: card2 },
    });

    // Determine winner
    let winnerId: string;
    let result: 'player1' | 'player2' | 'tie';

    if (card1 > card2) {
      winnerId = player1.userId;
      result = 'player1';
    } else if (card2 > card1) {
      winnerId = player2.userId;
      result = 'player2';
    } else {
      // Tie - split pot (each gets their buy-in back)
      winnerId = '';
      result = 'tie';
    }

    const pot = player1.chipStack + player2.chipStack;

    // Update chip balances
    if (result === 'tie') {
      // Split pot - each player gets their buy-in back
      const chipBalance1 = await tx.chipBalance.findUnique({
        where: { userId: player1.userId },
      });
      const chipBalance2 = await tx.chipBalance.findUnique({
        where: { userId: player2.userId },
      });

      if (!chipBalance1 || !chipBalance2) {
        throw new Error('Chip balance not found');
      }

      // Return buy-ins
      const newBalance1 = await tx.chipBalance.update({
        where: { userId: player1.userId },
        data: { chips: { increment: player1.chipStack } },
      });

      const newBalance2 = await tx.chipBalance.update({
        where: { userId: player2.userId },
        data: { chips: { increment: player2.chipStack } },
      });

      // Audit logs
      await tx.chipAudit.create({
        data: {
          userId: player1.userId,
          operation: 'game_tie',
          amountDelta: player1.chipStack,
          balanceBefore: chipBalance1.chips,
          balanceAfter: newBalance1.chips,
          reference: gameId,
          notes: `Tie - returned buy-in from game: ${game.name}`,
        },
      });

      await tx.chipAudit.create({
        data: {
          userId: player2.userId,
          operation: 'game_tie',
          amountDelta: player2.chipStack,
          balanceBefore: chipBalance2.chips,
          balanceAfter: newBalance2.chips,
          reference: gameId,
          notes: `Tie - returned buy-in from game: ${game.name}`,
        },
      });

      logger.info('Game tied', {
        gameId,
        card1,
        card2,
      });

      // Mark game as completed
      await tx.game.update({
        where: { id: gameId },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      return {
        result: 'tie' as const,
        card1,
        card2,
        player1: {
          userId: player1.userId,
          username: player1.user.username,
          card: card1,
          newBalance: newBalance1.chips.toString(),
        },
        player2: {
          userId: player2.userId,
          username: player2.user.username,
          card: card2,
          newBalance: newBalance2.chips.toString(),
        },
      };
    } else {
      // Winner takes all
      // Get both players' current balances
      const balance1 = await tx.chipBalance.findUnique({
        where: { userId: player1.userId },
      });
      const balance2 = await tx.chipBalance.findUnique({
        where: { userId: player2.userId },
      });

      if (!balance1 || !balance2) {
        throw new Error('Chip balance not found');
      }

      const winnerBalance = winnerId === player1.userId ? balance1 : balance2;
      const loserBalance = winnerId === player1.userId ? balance2 : balance1;

      // Update winner's balance
      const newWinnerBalance = await tx.chipBalance.update({
        where: { userId: winnerId },
        data: { chips: { increment: pot } },
      });

      // Audit log for winner
      await tx.chipAudit.create({
        data: {
          userId: winnerId,
          operation: 'game_win',
          amountDelta: pot,
          balanceBefore: winnerBalance.chips,
          balanceAfter: newWinnerBalance.chips,
          reference: gameId,
          notes: `Won game: ${game.name}`,
        },
      });

      logger.info('Game completed', {
        gameId,
        winnerId,
        card1,
        card2,
        pot: pot.toString(),
      });

      // Mark game as completed
      await tx.game.update({
        where: { id: gameId },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      return {
        result: result,
        winnerId,
        card1,
        card2,
        pot: pot.toString(),
        player1: {
          userId: player1.userId,
          username: player1.user.username,
          card: card1,
          newBalance:
            winnerId === player1.userId
              ? newWinnerBalance.chips.toString()
              : loserBalance.chips.toString(),
        },
        player2: {
          userId: player2.userId,
          username: player2.user.username,
          card: card2,
          newBalance:
            winnerId === player2.userId
              ? newWinnerBalance.chips.toString()
              : loserBalance.chips.toString(),
        },
      };
    }
  });
}
