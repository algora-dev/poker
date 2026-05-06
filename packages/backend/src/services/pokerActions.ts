import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { evaluateHand, compareHands } from './poker/handEvaluator';
import { dealCards } from './poker/deck';
import { recordHandEvent } from './handLedger';

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
  const txStart = Date.now();
  try {
  return await prisma.$transaction(async (tx) => {
    const t0 = Date.now();
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

    const t1 = Date.now();
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

    // PHASE 3 [H-02]: optimistic concurrency guard.
    // Atomically claim the right to advance this turn before any state
    // mutation. The guard requires the same hand id, active player index,
    // stage, AND version we read above. If 0 rows match, another concurrent
    // request already advanced the turn (or the stage/version moved) and
    // this request is stale -> reject with a clear, retry-safe error.
    // See audits/t3-poker/06-dave-fix-prompt.md Phase 3.
    const guard = await tx.hand.updateMany({
      where: {
        id: currentHand.id,
        activePlayerIndex: currentHand.activePlayerIndex,
        stage: currentHand.stage,
        version: currentHand.version,
      },
      data: { version: { increment: 1 } },
    });
    if (guard.count === 0) {
      throw new Error('Stale action - turn already advanced');
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

      case 'all-in': {
        // Calculate previous contribution in this stage
        const allInContribution = await tx.handAction.aggregate({
          where: {
            handId: currentHand.id,
            userId,
            stage: currentHand.stage,
          },
          _sum: { amount: true },
        });
        const allInAlreadyIn = allInContribution._sum.amount || BigInt(0);
        
        // Push all remaining chips
        actionAmount = playerChipStack;
        playerPosition = 'all_in';
        playerChipStack = BigInt(0);
        newPot += actionAmount;
        
        // Total contribution this stage = previous + new
        const allInTotal = allInAlreadyIn + actionAmount;
        
        // Update current bet if this is effectively a raise
        if (allInTotal > currentHand.currentBet) {
          newCurrentBet = allInTotal;
        }
        break;
      }

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
        
        // Prisma's BigInt aggregate sum can be typed as `bigint | number | null`
        // in some setups; coerce explicitly so the arithmetic stays in bigint.
        const sumCallAmount = myContribution._sum.amount;
        const alreadyContributed: bigint = sumCallAmount == null ? BigInt(0) : BigInt(sumCallAmount);
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

      case 'raise': {
        if (!raiseAmount || raiseAmount <= 0) {
          throw new Error('Invalid raise amount');
        }
        const raiseTotalBigInt = BigInt(Math.floor(raiseAmount * 1_000_000));
        if (raiseTotalBigInt <= currentHand.currentBet) {
          throw new Error('Raise must be higher than current bet');
        }

        // Calculate minimum raise increment for this stage.
        // Rule: a raise must increase the current bet by at least the size of
        // the previous raise/bet in this round, or the big blind if none.
        // Walk this stage's actions to find the last full raise increment.
        const stageActionsForRaise = await tx.handAction.findMany({
          where: { handId: currentHand.id, stage: currentHand.stage },
          orderBy: { timestamp: 'asc' },
        });
        const stageBetsByUser = new Map<string, bigint>();
        let runningBet = BigInt(0);
        let lastRaiseIncrement = game.bigBlind;
        for (const a of stageActionsForRaise) {
          if (!a.amount) continue;
          const prior = stageBetsByUser.get(a.userId) || BigInt(0);
          const newTotal = prior + a.amount;
          stageBetsByUser.set(a.userId, newTotal);
          // Treat any action that pushes the high-water bet as a (possibly partial) raise.
          // Only count it as setting the new minimum increment if it's a FULL raise
          // (>= previous lastRaiseIncrement). A short all-in does not reopen action.
          if (newTotal > runningBet) {
            const increment = newTotal - runningBet;
            if (a.action === 'raise' || (a.action === 'all-in' && increment >= lastRaiseIncrement)) {
              lastRaiseIncrement = increment;
            }
            runningBet = newTotal;
          }
        }
        const minRaiseTotal = currentHand.currentBet + lastRaiseIncrement;

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

        // Min-raise enforcement: reject under-min raises UNLESS the player is
        // going all-in for less (short stack is always allowed to shove).
        const isAllInShove = actionAmount >= playerChipStack;
        if (!isAllInShove && raiseTotalBigInt < minRaiseTotal) {
          const minDisplay = (Number(minRaiseTotal) / 1_000_000).toFixed(2);
          throw new Error(`Raise must be at least ${minDisplay} (min-raise rule)`);
        }

        if (actionAmount > playerChipStack) {
          // All-in
          actionAmount = playerChipStack;
          playerPosition = 'all_in';
        } else if (isAllInShove) {
          playerPosition = 'all_in';
        }
        playerChipStack -= actionAmount;
        newPot += actionAmount;

        // PHASE 2 [H-01]: currentBet must reflect ACTUAL contribution after
        // stack capping, never the requested raise target. A short all-in
        // can only push currentBet to what the player actually paid.
        // See audits/t3-poker/06-dave-fix-prompt.md Phase 2.
        const actualTotalContribution = raiseAlreadyIn + actionAmount;
        if (actualTotalContribution > currentHand.currentBet) {
          newCurrentBet = actualTotalContribution;
        }
        break;
      }

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

    // Capture before-state for the ledger event before we mutate the player.
    const stackBefore = player.chipStack;
    const potBefore = currentHand.pot;

    // Update player
    await tx.gamePlayer.update({
      where: { id: player.id },
      data: {
        chipStack: playerChipStack,
        position: playerPosition,
      },
    });

    // Phase 7 [M-05]: action_applied ledger event with before/after state.
    // No private cards in this payload — ledger privacy gate enforces it.
    await recordHandEvent(tx, {
      gameId: game.id,
      handId: currentHand.id,
      userId,
      eventType: 'action_applied',
      payload: {
        action,
        amount: actionAmount.toString(),
        stage: currentHand.stage,
        activePlayerIndex: currentHand.activePlayerIndex,
        stackBefore: stackBefore.toString(),
        stackAfter: playerChipStack.toString(),
        potBefore: potBefore.toString(),
        potAfter: newPot.toString(),
        currentBetAfter: newCurrentBet.toString(),
        positionAfter: playerPosition,
      },
      correlationId: `act:${currentHand.id}:${currentHand.version + 1}`,
    });

    const t2 = Date.now();
    // Determine next state
    const bettingComplete = await checkBettingComplete(tx, currentHand.id, game.players);
    const t3 = Date.now();

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

        // Phase 7 [M-05]: ledger event for the fast-forward to river.
        // Board cards are public once revealed, so they may appear here.
        await recordHandEvent(tx, {
          gameId: game.id,
          handId: currentHand.id,
          eventType: 'street_advanced',
          payload: {
            fromStage: currentHand.stage,
            toStage: 'river',
            allInFastForward: true,
            board,
          },
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

        // Phase 7 [M-05]: ledger event for the street advance.
        // Re-read the freshly updated hand so the public board is captured.
        const advancedHand = await tx.hand.findUnique({ where: { id: currentHand.id } });
        await recordHandEvent(tx, {
          gameId: game.id,
          handId: currentHand.id,
          eventType: 'street_advanced',
          payload: {
            fromStage: currentHand.stage,
            toStage: nextStage,
            board: advancedHand ? JSON.parse(advancedHand.board) : [],
            potAfter: newPot.toString(),
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

      const tEnd = Date.now();
      const timing = `query=${t1-t0}ms action=${t2-t1}ms betting=${t3-t2}ms turn=${tEnd-t3}ms TOTAL=${tEnd-t0}ms wait=${t0-txStart}ms`;
      logger.info(`TIMING: ${timing}`);
      // Also log to DB
      try {
        const { appLog } = await import('./appLogger');
        await appLog('info', 'system', `TIMING: ${timing}`, { query: t1-t0, action: t2-t1, betting: t3-t2, turn: tEnd-t3, total: tEnd-t0, wait: t0-txStart }, { gameId, userId });
      } catch(_) {}
      return {
        action,
        nextPlayer: freshTurnPlayers[nextPlayerIndex].userId,
        pot: newPot.toString(),
        currentBet: newCurrentBet.toString(),
        stage: currentHand.stage,
        actionBy: userId,
        actionAmount: actionAmount.toString(),
      };
    }
  });
  } catch (err: any) {
    // Log ALL errors to database
    try {
      const { logError } = await import('./appLogger');
      await logError('action', `processAction FAILED: ${action}`, err, { gameId, userId });
    } catch (_) {
      console.error('PROCESS_ACTION_FATAL:', err?.message, err?.stack);
    }
    throw err; // Re-throw so API handler catches it
  }
}

/**
 * Handle fold win - last remaining player takes the pot
 * Exported for tests (Phase 1 chip-conservation invariants).
 */
export async function handleFoldWin(tx: any, game: any, hand: any, winner: any) {
  // PHASE 1: Award pot to winner's in-table stack ONLY.
  // Off-table withdrawable balance (ChipBalance) MUST NOT change here.
  // ChipBalance is only credited at game-end refund / leave-table cashout.
  // See audits/t3-poker/06-dave-fix-prompt.md Phase 1.
  await tx.gamePlayer.update({
    where: { id: winner.id },
    data: {
      chipStack: {
        increment: hand.pot,
      },
    },
  });

  // Mark hand as completed
  await tx.hand.update({
    where: { id: hand.id },
    data: {
      stage: 'completed',
      winnerIds: JSON.stringify([winner.userId]),
      completedAt: new Date(),
    },
  });

  // Phase 7 [M-05]: ledger trail for fold-win.
  await recordHandEvent(tx, {
    gameId: game.id,
    handId: hand.id,
    userId: winner.userId,
    eventType: 'pot_awarded',
    payload: {
      reason: 'fold_win',
      potNumber: 1,
      amount: hand.pot.toString(),
      winnerIds: [winner.userId],
      shareEach: hand.pot.toString(),
      remainder: '0',
    },
  });
  await recordHandEvent(tx, {
    gameId: game.id,
    handId: hand.id,
    eventType: 'hand_completed',
    payload: {
      reason: 'fold_win',
      winnerIds: [winner.userId],
      potTotal: hand.pot.toString(),
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

  // Eliminate players with zero chips
  for (const player of players) {
    if (
      player.position !== 'eliminated' &&
      player.chipStack <= BigInt(0)
    ) {
      await tx.gamePlayer.update({
        where: { id: player.id },
        data: { position: 'eliminated' },
      });
      logger.info('Player eliminated (zero chips)', {
        gameId: game.id,
        userId: player.userId,
        chipStack: player.chipStack.toString(),
      });
    }
  }

  // Count remaining (non-eliminated) players
  const remaining = players.filter(
    (p: any) => p.position !== 'eliminated' && p.chipStack > BigInt(0)
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

    // PHASE 1: end-of-game cashout. Move each remaining player's in-table
    // chipStack into their off-table ChipBalance and zero the chipStack.
    // This is a single chip-mass move, not a credit — total chips conserved.
    for (const player of players) {
      if (player.chipStack > BigInt(0)) {
        const stackToCashOut = player.chipStack;
        const balance = await tx.chipBalance.findUnique({
          where: { userId: player.userId },
        });
        if (balance) {
          const newBal = await tx.chipBalance.update({
            where: { userId: player.userId },
            data: { chips: { increment: stackToCashOut } },
          });
          // Zero the in-table stack so chips are not held in two places.
          await tx.gamePlayer.update({
            where: { id: player.id },
            data: { chipStack: BigInt(0) },
          });
          await tx.chipAudit.create({
            data: {
              userId: player.userId,
              operation: 'game_cashout',
              amountDelta: stackToCashOut,
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

    // Phase 7 [M-05]: ledger event for game-level completion.
    await recordHandEvent(tx, {
      gameId: game.id,
      userId: remaining[0]?.userId ?? null,
      eventType: 'game_completed',
      payload: {
        winnerId: remaining[0]?.userId ?? null,
        remainingPlayers: remaining.length,
      },
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
 * Exported for tests (Phase 2 raise/all-in correctness).
 */
export async function checkBettingComplete(tx: any, handId: string, players: any[]): Promise<boolean> {
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

  // Track the last raiser/bettor — the round ends when action returns to them.
  //
  // PHASE 2 [M-01]: a short all-in (one whose increment over the current
  // high-water bet is LESS than the last legal raise increment) is treated
  // as a call for action-reopening purposes. It still moves chips into the
  // pot, but it does NOT reset the action — the original aggressor cannot
  // be forced to re-respond. See audits/t3-poker/06-dave-fix-prompt.md
  // Phase 2 and Hold'em short-all-in rules.
  let lastAggressorId: string | null = null;
  let actedSinceLastRaise = new Set<string>();
  // Re-fetch the game's bigBlind for the default minimum increment.
  const handGame = await tx.game.findUnique({ where: { id: hand.gameId } });
  const bigBlind: bigint = handGame?.bigBlind ?? BigInt(0);
  let runningHighBet = BigInt(0);
  let lastRaiseIncrement: bigint = bigBlind;
  const cumulativeBetByUser = new Map<string, bigint>();

  for (const action of stageActions) {
    if (action.action === 'blind') {
      // Blinds set the initial high-water bet but do not count as "acting".
      const prior = cumulativeBetByUser.get(action.userId) || BigInt(0);
      const newCum = prior + (action.amount || BigInt(0));
      cumulativeBetByUser.set(action.userId, newCum);
      if (newCum > runningHighBet) runningHighBet = newCum;
      continue;
    }

    const prior = cumulativeBetByUser.get(action.userId) || BigInt(0);
    const newCum = prior + (action.amount || BigInt(0));
    cumulativeBetByUser.set(action.userId, newCum);

    if (action.action === 'raise') {
      // A normal 'raise' must (per the raise branch's min-raise check) be a
      // full legal raise. Always treat it as the aggressor.
      if (newCum > runningHighBet) {
        lastRaiseIncrement = newCum - runningHighBet;
        runningHighBet = newCum;
      }
      lastAggressorId = action.userId;
      actedSinceLastRaise = new Set([action.userId]);
    } else if (action.action === 'all-in') {
      // Short-all-in test: only reopen action if the increment over the
      // current high-water bet is at least the last legal raise increment.
      const increment = newCum > runningHighBet ? newCum - runningHighBet : BigInt(0);
      const reopens = increment >= lastRaiseIncrement && increment > BigInt(0);
      if (newCum > runningHighBet) runningHighBet = newCum;
      if (reopens) {
        lastRaiseIncrement = increment;
        lastAggressorId = action.userId;
        actedSinceLastRaise = new Set([action.userId]);
      } else {
        // Short all-in: counts as a response but does NOT reopen action.
        actedSinceLastRaise.add(action.userId);
      }
    } else {
      actedSinceLastRaise.add(action.userId);
    }
  }
  
  const actedList = Array.from(playerLastAction.entries()).map(([uid, act]) => `${uid.slice(-6)}:${act}`);
  const betsList = Array.from(playerBets.entries()).map(([uid, amt]) => `${uid.slice(-6)}:${(Number(amt)/1e6).toFixed(2)}`);
  logger.info(`BETTING: stage=${hand.stage} actions=${realActions.length} lastAggressor=${lastAggressorId?.slice(-6)||'none'} acted=[${actedList}] bets=[${betsList}]`);
  
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

  // Players who can still make decisions (not folded, eliminated, or all-in)
  const playersWhoCanAct = activePlayers.filter(p => p.position === 'active');
  
  // If no one can act (all remaining are all-in), betting is complete
  if (playersWhoCanAct.length === 0) {
    logger.info('Betting complete: all remaining players are all-in');
    return true;
  }

  // CORE RULE: If there was a raise, everyone who can act must have acted SINCE that raise
  if (lastAggressorId) {
    const allRespondedToRaise = playersWhoCanAct.every(p => actedSinceLastRaise.has(p.userId));
    const betsOfActors = playersWhoCanAct.map(p => playerBets.get(p.userId) || BigInt(0));
    const maxBetAct = betsOfActors.reduce((max, b) => b > max ? b : max, BigInt(0));
    const betsMatch = betsOfActors.every(b => b === maxBetAct);
    
    logger.info(`BETTING_CHECK: aggressor=${lastAggressorId.slice(-6)} responded=${allRespondedToRaise} betsMatch=${betsMatch} canAct=${playersWhoCanAct.map(p=>p.userId.slice(-6))}`);
    
    if (allRespondedToRaise && betsMatch) {
      logger.info('Betting complete: all responded to last raise, bets matched');
      return true;
    }
    return false;
  }
  
  // No raise happened — check if everyone who can act has acted
  const playersWhoActed = new Set(Array.from(playerLastAction.keys()));
  const allActed = playersWhoCanAct.every(p => playersWhoActed.has(p.userId));
  
  if (!allActed) {
    logger.info(`BETTING_CHECK: no raise, waiting for: ${playersWhoCanAct.filter(p => !playersWhoActed.has(p.userId)).map(p=>p.userId.slice(-6))}`);
    return false;
  }

  // Everyone acted, no raise — check if all checked or all bets equal
  const allChecked = playersWhoCanAct.every(p => playerLastAction.get(p.userId) === 'check');
  if (allChecked) {
    logger.info('Betting complete: all checked');
    return true;
  }

  const betAmounts = playersWhoCanAct.map(p => playerBets.get(p.userId) || BigInt(0));
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

  // Check if anyone is all-in — only complete if all active players have acted
  // and their bets match or exceed the highest active bet
  const allInPlayers = activePlayers.filter(p => p.position === 'all_in');
  if (allInPlayers.length > 0 && allBetsEqual) {
    logger.info('Betting complete: all-in player(s) present and active bets matched');
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
// Exported for tests (Phase 1 chip-conservation invariants).
export async function handleShowdown(tx: any, game: any, hand: any) {
  const { calculateSidePots, storeSidePots, getSidePots } = await import('./sidePots');
  
  // Re-fetch fresh player positions (game.players may be stale within transaction)
  const freshShowdownPlayers = await tx.gamePlayer.findMany({
    where: { gameId: game.id },
    orderBy: { seatIndex: 'asc' },
    include: { user: { select: { id: true, username: true } } },
  });
  const players = freshShowdownPlayers.filter((p: any) => p.position !== 'folded' && p.position !== 'eliminated');
  const board = JSON.parse(hand.board);

  // Calculate and store side pots (use fresh players for accurate positions)
  const sidePots = await calculateSidePots(tx, hand.id, freshShowdownPlayers);
  await storeSidePots(tx, hand.id, sidePots);

  // Phase 7 [M-05]: ledger event for side-pot construction (proof of
  // eligibility/amounts even before evaluation runs).
  await recordHandEvent(tx, {
    gameId: game.id,
    handId: hand.id,
    eventType: 'side_pots_built',
    payload: {
      pots: sidePots.map((p: any) => ({
        potNumber: p.potNumber,
        amount: p.amount.toString(),
        eligiblePlayerIds: p.eligiblePlayerIds,
      })),
      totalPot: hand.pot.toString(),
    },
  });

  // Evaluate all active players' hands
  const evaluations = players.map((p: any) => ({
    userId: p.userId,
    username: p.user.username,
    holeCards: JSON.parse(p.holeCards),
    evaluation: evaluateHand(JSON.parse(p.holeCards), board),
  }));

  // Phase 7 [M-05]: showdown_evaluated. The hand is over once we are here,
  // so hole cards may appear in the ledger payload (privacy gate is scoped
  // to mid-hand events).
  await recordHandEvent(tx, {
    gameId: game.id,
    handId: hand.id,
    eventType: 'showdown_evaluated',
    payload: {
      board,
      evaluations: evaluations.map((e: any) => ({
        userId: e.userId,
        username: e.username,
        holeCards: e.holeCards,
        rank: e.evaluation.rank,
        description: e.evaluation.description,
        bestCards: e.evaluation.cards,
      })),
    },
  });

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

    // Split pot among winners. PHASE 9 follow-up [L-01]: integer-division
    // remainder must be allocated deterministically; otherwise odd-chip
    // pots leak chip mass over time. Convention: first winning seat left
    // of the dealer button receives the remainder. The simulator's chip-
    // conservation invariant catches the leak if this is ever broken.
    const potShare = pot.amount / BigInt(potWinnerIds.length);
    const remainder = pot.amount - potShare * BigInt(potWinnerIds.length);

    // Determine the seat to receive any odd-chip remainder.
    let remainderRecipientId: string | null = null;
    if (remainder > 0n) {
      const numSeats = freshShowdownPlayers.length;
      const dealer = (game.dealerIndex ?? 0) % Math.max(numSeats, 1);
      // Walk seats left-of-dealer, return the first one that's a pot winner.
      for (let i = 1; i <= numSeats; i++) {
        const seat = freshShowdownPlayers[(dealer + i) % numSeats];
        if (seat && potWinnerIds.includes(seat.userId)) {
          remainderRecipientId = seat.userId;
          break;
        }
      }
      // Fallback: deterministic by userId order so we never lose chips.
      if (!remainderRecipientId) {
        remainderRecipientId = potWinnerIds.slice().sort()[0];
      }
    }

    logger.info(`Pot ${pot.potNumber} awarded`, {
      amount: pot.amount.toString(),
      winners: potWinnerNames,
      shareEach: potShare.toString(),
      remainder: remainder.toString(),
      remainderRecipientId,
    });

    potResults.push({
      potNumber: pot.potNumber,
      amount: pot.amount.toString(),
      winnerIds: potWinnerIds,
      winnerNames: potWinnerNames,
    });

    // Track all winners
    potWinnerIds.forEach(id => allWinnerIds.add(id));

    // PHASE 1: Award pot share to winner's in-table stack ONLY.
    // Off-table withdrawable balance (ChipBalance) MUST NOT change here.
    // ChipBalance is only credited at game-end refund / leave-table cashout.
    // See audits/t3-poker/06-dave-fix-prompt.md Phase 1.
    for (const winnerId of potWinnerIds) {
      const winner = freshShowdownPlayers.find((p: any) => p.userId === winnerId);
      if (winner) {
        const extra = winnerId === remainderRecipientId ? remainder : 0n;
        await tx.gamePlayer.update({
          where: { id: winner.id },
          data: {
            chipStack: {
              increment: potShare + extra,
            },
          },
        });
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

    // Phase 7 [M-05]: pot_awarded with full allocation proof.
    await recordHandEvent(tx, {
      gameId: game.id,
      handId: hand.id,
      eventType: 'pot_awarded',
      payload: {
        potNumber: pot.potNumber,
        amount: pot.amount.toString(),
        eligiblePlayerIds: pot.eligiblePlayerIds,
        winnerIds: potWinnerIds,
        winningRank: bestHand.rank,
        winningDescription: bestHand.description,
        shareEach: potShare.toString(),
        remainder: remainder.toString(),
        // Phase 9 follow-up [L-01]: explicit remainder allocation.
        remainderRecipientId,
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

  // Phase 7 [M-05]: hand_completed via showdown.
  await recordHandEvent(tx, {
    gameId: game.id,
    handId: hand.id,
    eventType: 'hand_completed',
    payload: {
      reason: 'showdown',
      winnerIds,
      potTotal: hand.pot.toString(),
      numPots: sidePots.length,
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
