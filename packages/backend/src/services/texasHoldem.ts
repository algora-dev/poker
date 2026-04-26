import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { createDeck, shuffleDeck, dealCards, Card, formatCard } from './poker/deck';
import { evaluateHand, compareHands } from './poker/handEvaluator';

/**
 * Play Texas Hold'em (simplified - no betting rounds yet)
 * - Deal 2 hole cards to each player
 * - Deal 5 community cards (flop, turn, river)
 * - Evaluate best hands
 * - Award pot to winner
 */
export async function playTexasHoldem(gameId: string) {
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

    // Create and shuffle deck
    let deck = shuffleDeck(createDeck());

    // Deal hole cards
    const { cards: p1Hole, remaining: afterP1 } = dealCards(deck, 2);
    const { cards: p2Hole, remaining: afterP2 } = dealCards(afterP1, 2);

    // Deal community cards
    const { cards: communityCards, remaining: finalDeck } = dealCards(afterP2, 5);

    logger.info('Texas Hold\'em dealt', {
      gameId,
      player1Hole: p1Hole.map(formatCard),
      player2Hole: p2Hole.map(formatCard),
      community: communityCards.map(formatCard),
    });

    // Evaluate hands
    const p1Hand = evaluateHand(p1Hole, communityCards);
    const p2Hand = evaluateHand(p2Hole, communityCards);

    logger.info('Hands evaluated', {
      gameId,
      player1: {
        hand: p1Hand.description,
        cards: p1Hand.cards.map(formatCard),
      },
      player2: {
        hand: p2Hand.description,
        cards: p2Hand.cards.map(formatCard),
      },
    });

    // Determine winner
    const comparison = compareHands(p1Hand, p2Hand);
    let winnerId: string;
    let result: 'player1' | 'player2' | 'tie';

    if (comparison > 0) {
      winnerId = player1.userId;
      result = 'player1';
    } else if (comparison < 0) {
      winnerId = player2.userId;
      result = 'player2';
    } else {
      winnerId = '';
      result = 'tie';
    }

    const pot = player1.chipStack + player2.chipStack;

    // Update chip balances
    if (result === 'tie') {
      // Split pot
      const chipBalance1 = await tx.chipBalance.findUnique({
        where: { userId: player1.userId },
      });
      const chipBalance2 = await tx.chipBalance.findUnique({
        where: { userId: player2.userId },
      });

      if (!chipBalance1 || !chipBalance2) {
        throw new Error('Chip balance not found');
      }

      const newBalance1 = await tx.chipBalance.update({
        where: { userId: player1.userId },
        data: { chips: { increment: player1.chipStack } },
      });

      const newBalance2 = await tx.chipBalance.update({
        where: { userId: player2.userId },
        data: { chips: { increment: player2.chipStack } },
      });

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

      logger.info('Texas Hold\'em tied', { gameId });

      await tx.game.update({
        where: { id: gameId },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      return {
        result: 'tie' as const,
        player1: {
          userId: player1.userId,
          username: player1.user.username,
          holeCards: p1Hole.map(formatCard),
          hand: p1Hand.description,
          bestCards: p1Hand.cards.map(formatCard),
          newBalance: newBalance1.chips.toString(),
        },
        player2: {
          userId: player2.userId,
          username: player2.user.username,
          holeCards: p2Hole.map(formatCard),
          hand: p2Hand.description,
          bestCards: p2Hand.cards.map(formatCard),
          newBalance: newBalance2.chips.toString(),
        },
        communityCards: communityCards.map(formatCard),
      };
    } else {
      // Winner takes all
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

      const newWinnerBalance = await tx.chipBalance.update({
        where: { userId: winnerId },
        data: { chips: { increment: pot } },
      });

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

      logger.info('Texas Hold\'em completed', {
        gameId,
        winnerId,
        pot: pot.toString(),
      });

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
        player1: {
          userId: player1.userId,
          username: player1.user.username,
          holeCards: p1Hole.map(formatCard),
          hand: p1Hand.description,
          bestCards: p1Hand.cards.map(formatCard),
          newBalance:
            winnerId === player1.userId
              ? newWinnerBalance.chips.toString()
              : loserBalance.chips.toString(),
        },
        player2: {
          userId: player2.userId,
          username: player2.user.username,
          holeCards: p2Hole.map(formatCard),
          hand: p2Hand.description,
          bestCards: p2Hand.cards.map(formatCard),
          newBalance:
            winnerId === player2.userId
              ? newWinnerBalance.chips.toString()
              : loserBalance.chips.toString(),
        },
        communityCards: communityCards.map(formatCard),
        pot: pot.toString(),
      };
    }
  });
}
