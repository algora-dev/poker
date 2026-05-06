import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { createDeck, shuffleDeck, dealCards, Card } from './poker/deck';

/**
 * Initialize a new hand - deal cards, post blinds.
 *
 * Pass a `parentTx` to participate in an existing transaction (used by the
 * Phase 5 atomic game start so status flip + first hand init are committed
 * together). Without parentTx, opens its own transaction.
 */
export async function initializeHand(gameId: string, parentTx?: any) {
  const run = async (tx: any) => {
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
      },
    });

    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== 'in_progress') {
      throw new Error('Game must be in progress');
    }

    // Filter to active (non-eliminated) players
    const activePlayers = game.players.filter((p: any) => p.position !== 'eliminated');
    
    if (activePlayers.length < 2) {
      throw new Error('Need at least 2 active players');
    }

    const numPlayers = game.players.length; // total seats
    const numActive = activePlayers.length;

    // Determine dealer (button) — already set by checkGameContinuation
    const dealerIndex = game.dealerIndex % numPlayers;

    // Helper: find next active player index after a given seat index
    const nextActive = (startIdx: number): number => {
      let idx = (startIdx + 1) % numPlayers;
      let safety = 0;
      while (game.players[idx].position === 'eliminated' && safety < numPlayers) {
        idx = (idx + 1) % numPlayers;
        safety++;
      }
      return idx;
    };

    // Heads-up (2 active): dealer is small blind
    // 3+ active: small blind is first active left of dealer
    const isHeadsUp = numActive === 2;
    const smallBlindIndex = isHeadsUp ? dealerIndex : nextActive(dealerIndex);
    const bigBlindIndex = isHeadsUp ? nextActive(dealerIndex) : nextActive(smallBlindIndex);

    // Create shuffled deck
    const deck = shuffleDeck(createDeck());

    // Deal 2 hole cards to each active player (skip eliminated)
    let remainingDeck = deck;
    for (let i = 0; i < game.players.length; i++) {
      if (game.players[i].position === 'eliminated') {
        continue; // Skip eliminated players
      }
      const { cards, remaining } = dealCards(remainingDeck, 2);
      remainingDeck = remaining;
      
      await tx.gamePlayer.update({
        where: { id: game.players[i].id },
        data: {
          holeCards: JSON.stringify(cards),
          position: 'active',
        },
      });
    }

    // Calculate blind amounts BEFORE creating hand
    const sbPlayer = game.players[smallBlindIndex];
    const bbPlayer = game.players[bigBlindIndex];
    
    const sbAmount = sbPlayer.chipStack < game.smallBlind ? sbPlayer.chipStack : game.smallBlind;
    const sbPosition = sbPlayer.chipStack <= game.smallBlind ? 'all_in' : 'active';
    const bbAmount = bbPlayer.chipStack < game.bigBlind ? bbPlayer.chipStack : game.bigBlind;
    const bbPosition = bbPlayer.chipStack <= game.bigBlind ? 'all_in' : 'active';

    // Create new hand
    const handNumber = await tx.hand.count({ where: { gameId } }) + 1;

    // Preflop: in heads-up, dealer/SB acts first.
    // In 3+ players, first to act is left of BB (UTG).
    const firstToActIndex = isHeadsUp 
      ? smallBlindIndex 
      : nextActive(bigBlindIndex);

    const hand = await tx.hand.create({
      data: {
        gameId,
        handNumber,
        deck: JSON.stringify(remainingDeck),
        board: JSON.stringify([]),
        pot: sbAmount + bbAmount,
        currentBet: bbAmount, // Actual BB amount (may be less if all-in)
        activePlayerIndex: firstToActIndex,
        turnStartedAt: new Date(),
        stage: 'preflop',
      },
    });

    // Post blinds (deduct from player chip stacks)
    
    await tx.gamePlayer.update({
      where: { id: sbPlayer.id },
      data: {
        chipStack: {
          decrement: sbAmount,
        },
        position: sbPosition,
      },
    });

    await tx.gamePlayer.update({
      where: { id: bbPlayer.id },
      data: {
        chipStack: {
          decrement: bbAmount,
        },
        position: bbPosition,
      },
    });

    logger.info('Blinds posted', {
      sbPlayer: sbPlayer.userId,
      sbSeat: smallBlindIndex,
      sbAmount: sbAmount.toString(),
      sbPosition,
      bbPlayer: bbPlayer.userId,
      bbSeat: bigBlindIndex,
      bbAmount: bbAmount.toString(),
      bbPosition,
      currentBet: bbAmount.toString(),
    });

    // Record blind actions (with stage!)
    await tx.handAction.create({
      data: {
        handId: hand.id,
        userId: sbPlayer.userId,
        action: 'blind',
        amount: sbAmount,
        stage: 'preflop',
      },
    });

    await tx.handAction.create({
      data: {
        handId: hand.id,
        userId: bbPlayer.userId,
        action: 'blind',
        amount: bbAmount,
        stage: 'preflop',
      },
    });

    // Update game with current hand
    await tx.game.update({
      where: { id: gameId },
      data: {
        currentHandId: hand.id,
      },
    });

    logger.info(`HAND INIT #${handNumber}: pot=${hand.pot.toString()} bet=${bbAmount.toString()} dealer=${game.dealerIndex} sb=${smallBlindIndex}(${sbPlayer.userId.slice(-6)}) bb=${bigBlindIndex}(${bbPlayer.userId.slice(-6)}) first=${firstToActIndex} active=${numActive}`);

    return hand;
  };
  if (parentTx) return run(parentTx);
  return await prisma.$transaction(run);
}

/**
 * Atomically transition a game from 'waiting' to 'in_progress' and initialize
 * the first hand in ONE transaction. Per Phase 5 [H-05]:
 *   - status flip is guarded (status: 'waiting') -> idempotent under races
 *   - hand init runs INSIDE the same transaction -> any failure rolls back
 *   - returns { ok: true, hand } on success
 *   - returns { ok: false, code: 'already_started' | 'init_failed', error? }
 *     on a clean rejection. Caller decides how to surface to the client.
 *
 * Accepts an injectable prismaClient so unit tests can drive it without a DB.
 */
export async function atomicStartGame(
  gameId: string,
  client: { $transaction: (fn: (tx: any) => Promise<any>) => Promise<any> } = prisma
): Promise<
  | { ok: true; hand: any }
  | { ok: false; code: 'already_started'; message: string }
  | { ok: false; code: 'init_failed'; message: string; error?: any }
> {
  try {
    const hand = await client.$transaction(async (tx: any) => {
      const flip = await tx.game.updateMany({
        where: { id: gameId, status: 'waiting' },
        data: { status: 'in_progress', startedAt: new Date() },
      });
      if (flip.count === 0) {
        const err: any = new Error('already_started');
        err.__code = 'already_started';
        throw err;
      }
      return await initializeHand(gameId, tx);
    });
    return { ok: true, hand };
  } catch (err: any) {
    if (err?.__code === 'already_started') {
      return {
        ok: false,
        code: 'already_started',
        message: 'Game already started or completed',
      };
    }
    return {
      ok: false,
      code: 'init_failed',
      message: err?.message ?? 'Failed to initialize first hand',
      error: err,
    };
  }
}

/**
 * Get current game state
 */
export async function getGameState(gameId: string, userId: string) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      players: {
        orderBy: { seatIndex: 'asc' },
        include: {
          user: {
            select: { id: true, username: true, avatarId: true },
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

  const currentHand = game.hands[0];

  // Find current user's player
  const currentPlayer = game.players.find((p) => p.userId === userId);
  if (!currentPlayer) {
    throw new Error('You are not in this game');
  }

  // Calculate amount to call in CURRENT betting round
  // Now with stage tracking, this is simple and accurate!
  let amountToCall = BigInt(0);
  
  if (currentHand && currentHand.currentBet > BigInt(0)) {
    // Get contributions in CURRENT stage only (using the new stage field!)
    const myContribution = await prisma.handAction.aggregate({
      where: {
        handId: currentHand.id,
        userId: currentPlayer.userId,
        stage: currentHand.stage, // 🎯 KEY FIX: Filter by current stage
      },
      _sum: {
        amount: true,
      },
    });

    // Prisma's BigInt aggregate sum can be typed as `bigint | number | null`
    // in some setups; coerce explicitly so the arithmetic stays in bigint.
    const sumAmount = myContribution._sum.amount;
    const contributed: bigint = sumAmount == null ? BigInt(0) : BigInt(sumAmount);
    amountToCall = currentHand.currentBet - contributed;
    
    if (amountToCall < BigInt(0)) {
      amountToCall = BigInt(0);
    }

    logger.info(`amountToCall: user=${userId.slice(-6)} stage=${currentHand.stage} bet=${currentHand.currentBet.toString()} contributed=${contributed.toString()} owes=${amountToCall.toString()}`);
  }

  // Parse hole cards
  const myHoleCards = currentPlayer.holeCards
    ? JSON.parse(currentPlayer.holeCards)
    : [];

  // Get each player's contribution and last action in current stage
  const stageBets = new Map<string, bigint>();
  const lastActions = new Map<string, string>();
  if (currentHand) {
    const stageActions = await prisma.handAction.findMany({
      where: { handId: currentHand.id, stage: currentHand.stage },
      orderBy: { timestamp: 'asc' },
    });
    for (const a of stageActions) {
      if (a.amount) {
        stageBets.set(a.userId, (stageBets.get(a.userId) || BigInt(0)) + a.amount);
      }
      lastActions.set(a.userId, a.action);
    }
  }

  // Format all other players (hide their cards)
  const otherPlayers = game.players
    .filter(p => p.userId !== userId)
    .map(p => ({
      userId: p.userId,
      username: p.user.username,
      avatarId: p.user.avatarId,
      seatIndex: p.seatIndex,
      chipStack: p.chipStack.toString(),
      position: p.position,
      holeCards: [], // Hidden
      currentStageBet: (stageBets.get(p.userId) || BigInt(0)).toString(),
      lastAction: lastActions.get(p.userId) || null,
    }));

  // Calculate position indicators (D/SB/BB)
  const positionInfo = (() => {
    const numP = game.players.length;
    const numA = game.players.filter((p: any) => p.position !== 'eliminated').length;
    const dIdx = game.dealerIndex % numP;
    const dealerSeat = game.players[dIdx]?.seatIndex ?? -1;

    if (numA < 2) return { dealerSeat, sbSeat: -1, bbSeat: -1 };

    const nextActive = (start: number) => {
      let i = (start + 1) % numP;
      let safety = 0;
      while (game.players[i].position === 'eliminated' && safety < numP) {
        i = (i + 1) % numP;
        safety++;
      }
      return i;
    };

    const isHU = numA === 2;
    const sbIdx = isHU ? dIdx : nextActive(dIdx);
    const bbIdx = isHU ? nextActive(dIdx) : nextActive(sbIdx);

    return {
      dealerSeat,
      sbSeat: game.players[sbIdx]?.seatIndex ?? -1,
      bbSeat: game.players[bbIdx]?.seatIndex ?? -1,
    };
  })();

  return {
    gameId: game.id,
    gameName: game.name,
    status: game.status,
    creatorId: game.createdBy,
    smallBlind: game.smallBlind.toString(),
    bigBlind: game.bigBlind.toString(),
    pot: currentHand ? currentHand.pot.toString() : '0',
    currentBet: currentHand ? currentHand.currentBet.toString() : '0',
    amountToCall: amountToCall.toString(),
    stage: currentHand?.stage || 'waiting',
    board: currentHand ? JSON.parse(currentHand.board) : [],
    playerCount: game.players.length,
    myPlayer: {
      userId: currentPlayer.userId,
      username: currentPlayer.user.username,
      avatarId: currentPlayer.user.avatarId,
      seatIndex: currentPlayer.seatIndex,
      chipStack: currentPlayer.chipStack.toString(),
      holeCards: myHoleCards,
      position: currentPlayer.position,
      currentStageBet: (stageBets.get(currentPlayer.userId) || BigInt(0)).toString(),
      lastAction: lastActions.get(currentPlayer.userId) || null,
    },
    // Return ALL other players (not just one "opponent")
    opponents: otherPlayers,
    // Keep "opponent" for backward compatibility (first opponent)
    opponent: otherPlayers[0] || null,
    isMyTurn: currentHand
      ? game.players[currentHand.activePlayerIndex]?.userId === userId
      : false,
    activePlayerUserId: currentHand
      ? game.players[currentHand.activePlayerIndex]?.userId || null
      : null,
    turnStartedAt: currentHand?.turnStartedAt?.toISOString() || null,
    blindLevel: game.blindLevel,
    handsAtLevel: game.handsAtLevel,
    dealerSeatIndex: positionInfo.dealerSeat,
    sbSeatIndex: positionInfo.sbSeat,
    bbSeatIndex: positionInfo.bbSeat,
  };
}
