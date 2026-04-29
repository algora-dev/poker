import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { evaluateHand, compareHands } from './poker/handEvaluator';
import { dealCards } from './poker/deck';

type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'all-in';

/**
 * Process a player action
 */
export async function processAction(
  gameId: string,
  userId: string,
  action: ActionType,
  raiseAmount?: number
) {
  return await prisma.$transaction(async (tx) => {
    // Get game with current hand
    const game = await tx.game.findUnique({
      where: { id: gameId },
      include: {
        players: {
          orderBy: { seatIndex: 'asc' },
          include: {
            user: {
              select: { id: true, username: true },
            },
          },
        },
        hands: {
          where: { stage: { not: 'completed' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== 'in_progress') {
      throw new Error('Game is not in progress');
    }

    const currentHand = game.hands[0];
    if (!currentHand) {
      throw new Error('No active hand');
    }

    // Validate it's player's turn
    const activePlayer = game.players[currentHand.activePlayerIndex];
    if (!activePlayer || activePlayer.userId !== userId) {
      throw new Error('Not your turn');
    }

    // Get player's current data
    const player = await tx.gamePlayer.findFirst({
      where: { gameId, userId },
    });

    if (!player) {
      throw new Error('Player not found in game');
    }

    let actionAmount = BigInt(0);
    let newPot = currentHand.pot;
    let newCurrentBet = currentHand.currentBet;
    let playerChipStack = player.chipStack;
    let playerPosition = player.position;

    // Process action
    switch (action) {
      case 'fold':
        playerPosition = 'folded';
        // Mark player as folded first
        await tx.gamePlayer.update({
          where: { id: player.id },
          data: { position: 'folded' },
        });
        // Record fold action
        await tx.handAction.create({
          data: {
            handId: currentHand.id,
            userId,
            action: 'fold',
            amount: BigInt(0),
            stage: currentHand.stage,
          },
        });
        // Read FRESH player positions from DB (not stale game.players)
        const freshPlayers = await tx.gamePlayer.findMany({
          where: { gameId },
          orderBy: { seatIndex: 'asc' },
          include: { user: { select: { id: true, username: true } } },
        });
        const remainingActive = freshPlayers.filter(
          p => p.position !== 'folded' && p.position !== 'eliminated'
        );

        if (remainingActive.length === 1) {
          const winner = remainingActive[0];
          await handleFoldWin(tx, game, currentHand, winner);
          return {
            action: 'fold',
            gameOver: true,
            foldWinResult: {
              winnerId: winner.userId,
              winnerName: winner.user?.username || 'Unknown',
              pot: currentHand.pot.toString(),
            },
          };
        }

        // Multiple players still active — find next active player
        {
          const currentPlayerIndex = freshPlayers.findIndex(p => p.userId === userId);
          const numPlayers = freshPlayers.length;
          let nextIdx = (currentPlayerIndex + 1) % numPlayers;
          let safety = 0;
          while (
            safety < numPlayers &&
            (freshPlayers[nextIdx].position === 'folded' ||
             freshPlayers[nextIdx].position === 'eliminated' ||
             freshPlayers[nextIdx].userId === userId)
          ) {
            nextIdx = (nextIdx + 1) % numPlayers;
            safety++;
          }
          await tx.hand.update({
            where: { id: currentHand.id },
            data: {
              pot: newPot,
              currentBet: newCurrentBet,
              activePlayerIndex: nextIdx,
            },
          });
          return { action: 'fold', nextPlayer: freshPlayers[nextIdx].userId };
        }

      case 'all-in':
        // Push all remaining chips
        actionAmount = playerChipStack;
        playerPosition = 'all_in';
        playerChipStack = BigInt(0);
        newPot += actionAmount;
        
        // Update current bet if this is a raise
        if (actionAmount > currentHand.currentBet) {
          newCurrentBet = actionAmount;
        }
        break;

      case 'check':
        // Calculate contribution in CURRENT stage only
        const checkContribution = await tx.handAction.aggregate({
          where: {
            handId: currentHand.id,
            userId,
            stage: currentHand.stage, // 🎯 Current betting round only
          },
          _sum: { amount: true },
        });
        
        const contributed = checkContribution._sum.amount || BigInt(0);
        const amountOwed = currentHand.currentBet - contributed;
        
        if (amountOwed > BigInt(0)) {
          throw new Error(`Cannot check - you need to call ${(Number(amountOwed) / 1_000_000).toFixed(2)} more`);
        }
        // No chips moved, just pass turn
        break;

      case 'call':
        // Calculate contribution in CURRENT stage only
        const myContribution = await tx.handAction.aggregate({
          where: {
            handId: currentHand.id,
            userId,
            stage: currentHand.stage, // 🎯 Current betting round only
          },
          _sum: { amount: true },
        });
        
        const alreadyContributed = myContribution._sum.amount || BigInt(0);
        actionAmount = currentHand.currentBet - alreadyContributed;

        if (actionAmount <= BigInt(0)) {
          throw new Error('Nothing to call - you are already matched');
        }

        if (actionAmount > playerChipStack) {
          // All-in
          actionAmount = playerChipStack;
          playerPosition = 'all_in';
        }
        playerChipStack -= actionAmount;
        newPot += actionAmount;
        break;

      case 'raise':
        if (!raiseAmount || raiseAmount <= 0) {
          throw new Error('Invalid raise amount');
        }
        const raiseTotalBigInt = BigInt(Math.floor(raiseAmount * 1_000_000));
        if (raiseTotalBigInt <= currentHand.currentBet) {
          throw new Error('Raise must be higher than current bet');
        }
        // Calculate how much MORE the player needs to put in this stage
        const raiseContribution = await tx.handAction.aggregate({
          where: {
            handId: currentHand.id,
            userId,
            stage: currentHand.stage,
          },
          _sum: { amount: true },
        });
        const raiseAlreadyIn = raiseContribution._sum.amount || BigInt(0);
        actionAmount = raiseTotalBigInt - raiseAlreadyIn;
        if (actionAmount <= BigInt(0)) {
          throw new Error('Raise amount must exceed your current contribution');
        }
        if (actionAmount > playerChipStack) {
          // All-in
          actionAmount = playerChipStack;
          playerPosition = 'all_in';
        }
        playerChipStack -= actionAmount;
        newPot += actionAmount;
        newCurrentBet = raiseTotalBigInt;
        break;

    }

    // Record action
    await tx.handAction.create({
      data: {
        handId: currentHand.id,
        userId,
        action,
        amount: actionAmount,
        stage: currentHand.stage, // 🎯 Record which betting round this action belongs to
      },
    });

    // Update player
    await tx.gamePlayer.update({
      where: { id: player.id },
      data: {
        chipStack: playerChipStack,
        position: playerPosition,
      },
    });

    // Determine next state
    const bettingComplete = await checkBettingComplete(tx, currentHand.id, game.players);

    if (bettingComplete && playerPosition !== 'folded') {
      // Check if all remaining players are all-in (fast-forward to showdown)
      const freshPlayers = await tx.gamePlayer.findMany({
        where: { gameId: game.id },
        orderBy: { seatIndex: 'asc' },
      });
      const activeNonFolded = freshPlayers.filter(
        p => p.position !== 'folded' && p.position !== 'eliminated'
      );
      const canStillAct = activeNonFolded.filter(p => p.position === 'active');
      const allInCount = activeNonFolded.filter(p => p.position === 'all_in').length;
      
      // If no one can act (all remaining are all-in, or 1 active + rest all-in)
      if (canStillAct.length <= 1 && allInCount >= 1) {
        logger.info('All-in fast-forward to showdown', { gameId: game.id, canAct: canStillAct.length, allIn: allInCount });
        
        let stage = currentHand.stage;
        let board = JSON.parse(currentHand.board);
        const deck = JSON.parse(currentHand.deck);
        let deckIdx = 0;

        while (stage !== 'river') {
          const next = getNextStage(stage);
          if (next === 'showdown') break;
          const cards = next === 'flop' ? 3 : 1;
          board = [...board, ...deck.slice(deckIdx, deckIdx + cards)];
          deckIdx += cards;
          stage = next;
        }

        await tx.hand.update({
          where: { id: currentHand.id },
          data: { board: JSON.stringify(board), deck: JSON.stringify(deck.slice(deckIdx)), pot: newPot, stage: 'river' },
        });

        const showdownResults = await handleShowdown(tx, game, { ...currentHand, board: JSON.stringify(board), pot: newPot });
        return { action, gameOver: true, showdownResults };
      }
      // Advance to next street or showdown
      const freshHand = await tx.hand.findUnique({ where: { id: currentHand.id } });
      if (!freshHand || freshHand.stage === 'completed') {
        return { action };
      }
      const nextStage = getNextStage(freshHand.stage);

      if (nextStage === 'showdown') {
        // Evaluate hands and determine winner
        const showdownResults = await handleShowdown(tx, game, currentHand);
        return { action, gameOver: true, showdownResults };
      } else {
        // Deal community cards
        await advanceToNextStage(tx, currentHand, nextStage);

        // Update hand
        await tx.hand.update({
          where: { id: currentHand.id },
          data: {
            pot: newPot,
            currentBet: BigInt(0), // Reset bet for new street
            activePlayerIndex: getPostFlopFirstToAct(game),
            turnStartedAt: new Date(),
            stage: nextStage,
          },
        });

        return { action, nextStage };
      }
    } else {
      // Switch to next player (rotate through all active players)
      const currentPlayerIndex = game.players.findIndex(p => p.userId === userId);
      const numPlayers = game.players.length;
      
      // Find next ACTIVE player (skip folded/eliminated/all_in)
      let nextPlayerIndex = (currentPlayerIndex + 1) % numPlayers;
      let attempts = 0;
      
      // Read fresh positions
      const freshTurnPlayers = await tx.gamePlayer.findMany({
        where: { gameId },
        orderBy: { seatIndex: 'asc' },
      });
      
      while (
        attempts < numPlayers && 
        (freshTurnPlayers[nextPlayerIndex].position === 'folded' || 
         freshTurnPlayers[nextPlayerIndex].position === 'eliminated' ||
         freshTurnPlayers[nextPlayerIndex].position === 'all_in')
      ) {
        nextPlayerIndex = (nextPlayerIndex + 1) % numPlayers;
        attempts++;
      }
      
      // Safety check — if no active players can act, everyone is all-in → showdown
      if (attempts >= numPlayers) {
        // All remaining players are all-in — fast forward to showdown
        const canAct = freshTurnPlayers.filter(p => p.position === 'active');
        if (canAct.length === 0) {
          // Everyone is all-in or folded — deal remaining cards and showdown
          let stage = currentHand.stage;
          let board = JSON.parse(currentHand.board);
          const deck = JSON.parse(currentHand.deck);
          let deckIdx = 0;
          while (stage !== 'river') {
            const next = getNextStage(stage);
            if (next === 'showdown') break;
            const cards = next === 'flop' ? 3 : 1;
            board = [...board, ...deck.slice(deckIdx, deckIdx + cards)];
            deckIdx += cards;
            stage = next;
          }
          await tx.hand.update({
            where: { id: currentHand.id },
            data: { board: JSON.stringify(board), deck: JSON.stringify(deck.slice(deckIdx)), pot: newPot, stage: 'river' },
          });
          const showdownResults = await handleShowdown(tx, game, { ...currentHand, board: JSON.stringify(board), pot: newPot });
          return { action, gameOver: true, showdownResults };
        }
        throw new Error('No active players found for next turn');
      }

      await tx.hand.update({
        where: { id: currentHand.id },
        data: {
          pot: newPot,
          currentBet: newCurrentBet,
          activePlayerIndex: nextPlayerIndex,
          turnStartedAt: new Date(),
        },
      });

      logger.info('Turn switched', {
        handId: currentHand.id,
        from: userId,
        to: freshTurnPlayers[nextPlayerIndex].userId,
        pot: newPot.toString(),
        currentBet: newCurrentBet.toString(),
      });

      return { action, nextPlayer: freshTurnPlayers[nextPlayerIndex].userId };
    }
  });
}

/**
 * Handle fold win - last remaining player takes the pot
 */
async function handleFoldWin(tx: any, game: any, hand: any, winner: any) {
  // Award pot to winner's game stack
  await tx.gamePlayer.update({
    where: { id: winner.id },
    data: {
      chipStack: {
        increment: hand.pot,
      },
    },
  });

  // Award pot to winner's chip balance
  const winnerBalance = await tx.chipBalance.findUnique({
    where: { userId: winner.userId },
  });

  if (winnerBalance) {
    const newBalance = await tx.chipBalance.update({
      where: { userId: winner.userId },
      data: {
        chips: {
          increment: hand.pot,
        },
      },
    });

    // Audit log
    await tx.chipAudit.create({
      data: {
        userId: winner.userId,
        operation: 'game_win',
        amountDelta: hand.pot,
        balanceBefore: winnerBalance.chips,
        balanceAfter: newBalance.chips,
        reference: game.id,
        notes: `Won hand by fold in game: ${game.name}`,
      },
    });
  }

  // Mark hand as completed
  await tx.hand.update({
    where: { id: hand.id },
    data: {
      stage: 'completed',
      winnerIds: JSON.stringify([winner.userId]),
      completedAt: new Date(),
    },
  });

  // Check if game should end or continue
  await checkGameContinuation(tx, game);

  logger.info('Hand completed - all others folded', {
    gameId: game.id,
    handId: hand.id,
    winnerId: winner.userId,
    potWon: hand.pot.toString(),
  });
}

/**
 * After a hand completes, check if game continues or ends.
 * Eliminates broke players, rotates dealer, starts next hand or ends game.
 */
async function checkGameContinuation(tx: any, game: any) {
  const { checkBlindIncrease, getBlindLevel } = await import('./blindSchedule');

  // Re-fetch players with current chip stacks
  const players = await tx.gamePlayer.findMany({
    where: { gameId: game.id },
    orderBy: { seatIndex: 'asc' },
  });

  // Eliminate players who can't cover the big blind
  for (const player of players) {
    if (
      player.position !== 'eliminated' &&
      player.chipStack < game.bigBlind
    ) {
      await tx.gamePlayer.update({
        where: { id: player.id },
        data: { position: 'eliminated' },
      });
      logger.info('Player eliminated', {
        gameId: game.id,
        userId: player.userId,
        chipStack: player.chipStack.toString(),
      });
    }
  }

  // Count remaining (non-eliminated) players
  const remaining = players.filter(
    (p: any) => p.position !== 'eliminated' && p.chipStack >= game.bigBlind
  );

  if (remaining.length <= 1) {
    // Game over — last player standing wins
    await tx.game.update({
      where: { id: game.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    // Refund remaining chip stacks back to balances for all players
    for (const player of players) {
      if (player.chipStack > BigInt(0)) {
        const balance = await tx.chipBalance.findUnique({
          where: { userId: player.userId },
        });
        if (balance) {
          const newBal = await tx.chipBalance.update({
            where: { userId: player.userId },
            data: { chips: { increment: player.chipStack } },
          });
          await tx.chipAudit.create({
            data: {
              userId: player.userId,
              operation: 'game_cashout',
              amountDelta: player.chipStack,
              balanceBefore: balance.chips,
              balanceAfter: newBal.chips,
              reference: game.id,
              notes: `Cashed out from game: ${game.name}`,
            },
          });
        }
      }
    }

    logger.info('Game completed', {
      gameId: game.id,
      remainingPlayers: remaining.length,
      winner: remaining[0]?.userId,
    });
    return;
  }

  // Check blind escalation
  const newHandsAtLevel = game.handsAtLevel + 1;
  const blindChange = checkBlindIncrease(game.blindLevel, newHandsAtLevel);

  if (blindChange) {
    // Blinds increase!
    await tx.game.update({
      where: { id: game.id },
      data: {
        blindLevel: blindChange.newLevel,
        handsAtLevel: 0,
        smallBlind: blindChange.blinds.smallBlind,
        bigBlind: blindChange.blinds.bigBlind,
      },
    });
    logger.info('Blinds increased', {
      gameId: game.id,
      newLevel: blindChange.newLevel,
      smallBlind: blindChange.blinds.smallBlind.toString(),
      bigBlind: blindChange.blinds.bigBlind.toString(),
    });
  } else {
    await tx.game.update({
      where: { id: game.id },
      data: { handsAtLevel: newHandsAtLevel },
    });
  }

  // Game continues — rotate dealer and start next hand
  const numPlayers = players.length;
  let newDealerIndex = (game.dealerIndex + 1) % numPlayers;
  // Skip eliminated players for dealer
  let safety = 0;
  while (players[newDealerIndex].position === 'eliminated' && safety < numPlayers) {
    newDealerIndex = (newDealerIndex + 1) % numPlayers;
    safety++;
  }

  await tx.game.update({
    where: { id: game.id },
    data: { dealerIndex: newDealerIndex },
  });

  // Reset active players' positions for next hand
  for (const player of players) {
    if (player.position !== 'eliminated') {
      await tx.gamePlayer.update({
        where: { id: player.id },
        data: {
          position: 'active',
          holeCards: '[]',
        },
      });
    }
  }

  logger.info('Starting next hand', {
    gameId: game.id,
    dealerIndex: newDealerIndex,
    activePlayers: remaining.length,
  });
}

/**
 * Check if betting round is complete
 * Now with stage tracking, this is much simpler and more accurate!
 */
async function checkBettingComplete(tx: any, handId: string, players: any[]): Promise<boolean> {
  const hand = await tx.hand.findUnique({ 
    where: { id: handId },
  });

  if (!hand) return false;

  // Get actions in CURRENT stage only (using the new stage field!)
  const stageActions = await tx.handAction.findMany({
    where: {
      handId,
      stage: hand.stage, // 🎯 KEY FIX: Only look at current betting round
    },
    orderBy: { timestamp: 'asc' },
  });

  // Track each player's contribution and last action in THIS stage
  const playerBets = new Map<string, bigint>();
  const playerLastAction = new Map<string, string>();
  
  for (const action of stageActions) {
    if (!playerBets.has(action.userId)) {
      playerBets.set(action.userId, BigInt(0));
    }

    // Track bet amounts (including blinds if in preflop)
    if (action.amount) {
      const current = playerBets.get(action.userId)!;
      playerBets.set(action.userId, current + action.amount);
    }

    // Track last action (blinds don't count as "acting")
    if (action.action !== 'blind') {
      playerLastAction.set(action.userId, action.action);
    }
  }

  // Count real actions (not blinds)
  const realActions = stageActions.filter(a => a.action !== 'blind');
  
  logger.info('Checking betting complete', {
    handId,
    stage: hand.stage,
    totalActions: stageActions.length,
    realActions: realActions.length,
    playerLastActionSize: playerLastAction.size,
  });
  
  // Build list of players who are still in the hand
  // Use FRESH position data from database, not stale game.players
  const freshPlayers = await tx.gamePlayer.findMany({
    where: { gameId: hand.gameId },
    orderBy: { seatIndex: 'asc' },
  });
  const activePlayers = freshPlayers.filter(
    p => p.position !== 'folded' && p.position !== 'eliminated'
  );
  const numActivePlayers = activePlayers.length;

  // If only 1 active player left, betting is complete
  if (numActivePlayers <= 1) {
    logger.info('Betting complete: only 1 active player');
    return true;
  }

  // If no real actions at all in this stage, betting is not complete
  // (prevents instant-completion on new stages where all bets are 0)
  if (realActions.length === 0) {
    logger.info('Betting NOT complete: no actions yet in this stage');
    return false;
  }

  // Check if all active players have acted in this stage (blinds don't count)
  const playersWhoActed = new Set(Array.from(playerLastAction.keys()));
  const allActed = activePlayers.every(p => playersWhoActed.has(p.userId));

  logger.info('Betting check details', {
    stage: hand.stage,
    activePlayers: activePlayers.map(p => p.userId.slice(-6)),
    acted: Array.from(playerLastAction.entries()).map(([uid, act]) => `${uid.slice(-6)}:${act}`),
    bets: Array.from(playerBets.entries()).map(([uid, amt]) => `${uid.slice(-6)}:${amt.toString()}`),
    allActed,
  });

  if (!allActed) {
    return false;
  }

  // All active players have acted. Check if bets are settled.

  // Check if all active players checked
  const allChecked = activePlayers.every(p => playerLastAction.get(p.userId) === 'check');
  if (allChecked) {
    logger.info('Betting complete: all checked');
    return true;
  }

  // Check if bets are equal for all active players
  const betAmounts = activePlayers.map(p => playerBets.get(p.userId) || BigInt(0));
  const maxBet = betAmounts.reduce((max, bet) => bet > max ? bet : max, BigInt(0));
  const allBetsEqual = betAmounts.every(bet => bet === maxBet);

  logger.info('Player bets check', {
    numActivePlayers,
    maxBet: maxBet.toString(),
    allBetsEqual,
    bets: Array.from(playerBets.entries()).map(([uid, amt]) => ({ uid, amt: amt.toString() })),
  });

  if (allBetsEqual) {
    logger.info('Betting complete: all bets equal', {
      activePlayers: activePlayers.map(p => p.userId.slice(-6)),
      bets: Array.from(playerBets.entries()).map(([uid, amt]) => `${uid.slice(-6)}:${amt.toString()}`),
    });
    return true;
  }

  // Check if anyone is all-in (and bets are as equal as possible)
  const allInPlayers = activePlayers.filter(p => p.position === 'all_in');
  if (allInPlayers.length > 0) {
    // If someone is all-in and everyone else has matched or exceeded, betting is complete
    logger.info('Betting complete: all-in player(s) present');
    return true;
  }

  logger.info('Betting NOT complete');
  return false;
}



/**
 * Get first-to-act index post-flop (first active player left of dealer)
 */
function getPostFlopFirstToAct(game: any): number {
  const numPlayers = game.players.length;
  const dealerIndex = game.dealerIndex % numPlayers;
  
  // Start checking from left of dealer
  for (let offset = 1; offset <= numPlayers; offset++) {
    const idx = (dealerIndex + offset) % numPlayers;
    const p = game.players[idx];
    if (p.position !== 'folded' && p.position !== 'eliminated' && p.position !== 'all_in') {
      return idx;
    }
  }
  return 0; // fallback
}

/**
 * Get next stage
 */
function getNextStage(currentStage: string): string {
  const stages = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const currentIndex = stages.indexOf(currentStage);
  return stages[currentIndex + 1] || 'showdown';
}

/**
 * Advance to next stage - deal community cards
 */
async function advanceToNextStage(tx: any, hand: any, nextStage: string) {
  const currentBoard = JSON.parse(hand.board);
  const remainingDeck = JSON.parse(hand.deck);
  
  // Deal community cards from the SAME deck used at hand start
  const cardsToDeal = nextStage === 'flop' ? 3 : 1;
  const newCards = remainingDeck.slice(0, cardsToDeal);
  const updatedDeck = remainingDeck.slice(cardsToDeal);
  
  const updatedBoard = [...currentBoard, ...newCards];
  
  // Update hand with new board and remaining deck
  await tx.hand.update({
    where: { id: hand.id },
    data: {
      board: JSON.stringify(updatedBoard),
      deck: JSON.stringify(updatedDeck),
    },
  });
  
  logger.info('Advanced to next stage', {
    handId: hand.id,
    stage: nextStage,
    boardSize: updatedBoard.length,
    deckRemaining: updatedDeck.length,
  });
}

/**
 * Handle showdown - evaluate hands and award pot(s)
 */
async function handleShowdown(tx: any, game: any, hand: any) {
  const { calculateSidePots, storeSidePots, getSidePots } = await import('./sidePots');
  
  const players = game.players.filter((p: any) => p.position !== 'folded');
  const board = JSON.parse(hand.board);

  // Calculate and store side pots
  const sidePots = await calculateSidePots(tx, hand.id, game.players);
  await storeSidePots(tx, hand.id, sidePots);

  // Evaluate all active players' hands
  const evaluations = players.map((p: any) => ({
    userId: p.userId,
    username: p.user.username,
    holeCards: JSON.parse(p.holeCards),
    evaluation: evaluateHand(JSON.parse(p.holeCards), board),
  }));

  // Award each pot separately
  const allWinnerIds = new Set<string>();
  const potResults: Array<{
    potNumber: number;
    amount: string;
    winnerIds: string[];
    winnerNames: string[];
  }> = [];

  for (const pot of sidePots) {
    // Filter evaluations to only eligible players for this pot
    const eligibleEvaluations = evaluations.filter(e => 
      pot.eligiblePlayerIds.includes(e.userId)
    );

    if (eligibleEvaluations.length === 0) continue;

    // Sort by hand strength (best first)
    eligibleEvaluations.sort((a, b) => compareHands(b.evaluation, a.evaluation));

    // Find winner(s) of this pot
    const bestHand = eligibleEvaluations[0].evaluation;
    const potWinners = eligibleEvaluations.filter(e => 
      compareHands(e.evaluation, bestHand) === 0
    );
    const potWinnerIds = potWinners.map(w => w.userId);
    const potWinnerNames = potWinners.map(w => w.username);

    // Split pot among winners
    const potShare = pot.amount / BigInt(potWinnerIds.length);

    logger.info(`Pot ${pot.potNumber} awarded`, {
      amount: pot.amount.toString(),
      winners: potWinnerNames,
      shareEach: potShare.toString(),
    });

    potResults.push({
      potNumber: pot.potNumber,
      amount: pot.amount.toString(),
      winnerIds: potWinnerIds,
      winnerNames: potWinnerNames,
    });

    // Track all winners
    potWinnerIds.forEach(id => allWinnerIds.add(id));

    // Award chips to pot winners
    for (const winnerId of potWinnerIds) {
      const winner = game.players.find((p: any) => p.userId === winnerId);
      if (winner) {
        // Update game player chip stack
        await tx.gamePlayer.update({
          where: { id: winner.id },
          data: {
            chipStack: {
              increment: potShare,
            },
          },
        });
        
        // Update user's chip balance
        const chipBalance = await tx.chipBalance.findUnique({
          where: { userId: winnerId },
        });
        
        if (chipBalance) {
          const newBalance = await tx.chipBalance.update({
            where: { userId: winnerId },
            data: {
              chips: {
                increment: potShare,
              },
            },
          });
          
          // Audit log
          await tx.chipAudit.create({
            data: {
              userId: winnerId,
              operation: 'game_win',
              amountDelta: potShare,
              balanceBefore: chipBalance.chips,
              balanceAfter: newBalance.chips,
              reference: game.id,
              notes: `Won pot ${pot.potNumber} in game: ${game.name}`,
            },
          });
        }
      }
    }

    // Update side pot with winner
    await tx.sidePot.update({
      where: {
        handId_potNumber: {
          handId: hand.id,
          potNumber: pot.potNumber,
        },
      },
      data: {
        winnerId: potWinnerIds.length === 1 ? potWinnerIds[0] : null, // null if split
      },
    });
  }

  const winnerIds = Array.from(allWinnerIds);

  // Mark hand as completed
  await tx.hand.update({
    where: { id: hand.id },
    data: {
      stage: 'completed',
      winnerIds: JSON.stringify(winnerIds),
      completedAt: new Date(),
    },
  });

  // Check if game should end or continue
  await checkGameContinuation(tx, game);

  logger.info('Showdown complete', {
    gameId: game.id,
    handId: hand.id,
    numPots: sidePots.length,
    totalPot: hand.pot.toString(),
    winnerIds,
  });

  // Return detailed results for frontend
  return {
    handId: hand.id,
    pot: hand.pot.toString(),
    sidePots: potResults, // Array of { potNumber, amount, winnerIds, winnerNames }
    communityCards: board,
    winnerIds,
    players: evaluations.map((e: any) => ({
      userId: e.userId,
      username: e.username,
      holeCards: e.holeCards,
      handRank: e.evaluation.rank,
      handName: e.evaluation.description,
      bestCards: e.evaluation.cards,
      isWinner: winnerIds.includes(e.userId),
    })),
  };
}
