import { logger } from '../utils/logger';

/**
 * Calculate side pots for a hand with all-in players
 * 
 * Algorithm:
 * 1. Get total contribution per player
 * 2. Sort by contribution (lowest first)
 * 3. Create pots iteratively, capping at each all-in amount
 * 4. Return array of { potNumber, amount, cappedAt, eligiblePlayerIds }
 */
export async function calculateSidePots(
  tx: any,
  handId: string,
  players: any[]
): Promise<Array<{
  potNumber: number;
  amount: bigint;
  cappedAt: bigint;
  eligiblePlayerIds: string[];
}>> {
  // Get all actions for this hand (all stages)
  const actions = await tx.handAction.findMany({
    where: { handId },
    orderBy: { timestamp: 'asc' },
  });

  // Calculate total contribution per player
  const contributions = new Map<string, bigint>();
  
  for (const action of actions) {
    if (action.amount) {
      const current = contributions.get(action.userId) || BigInt(0);
      contributions.set(action.userId, current + action.amount);
    }
  }

  logger.info('Side pot calculation - contributions', {
    handId,
    contributions: Array.from(contributions.entries()).map(([uid, amt]) => ({
      userId: uid,
      amount: amt.toString(),
    })),
  });

  // Sort players by contribution (lowest first)
  const sortedContributions = Array.from(contributions.entries())
    .map(([userId, amount]) => ({ userId, amount }))
    .sort((a, b) => {
      if (a.amount < b.amount) return -1;
      if (a.amount > b.amount) return 1;
      return 0;
    });

  // If everyone contributed the same, single main pot
  if (sortedContributions.every(c => c.amount === sortedContributions[0].amount)) {
    const totalPot = sortedContributions.reduce((sum, c) => sum + c.amount, BigInt(0));
    const allPlayerIds = sortedContributions.map(c => c.userId);
    
    return [{
      potNumber: 0,
      amount: totalPot,
      cappedAt: sortedContributions[0].amount,
      eligiblePlayerIds: allPlayerIds,
    }];
  }

  // Create pots iteratively
  const pots: Array<{
    potNumber: number;
    amount: bigint;
    cappedAt: bigint;
    eligiblePlayerIds: string[];
  }> = [];

  let previousCap = BigInt(0);
  let remainingPlayers = [...sortedContributions];

  for (let i = 0; i < sortedContributions.length; i++) {
    const currentPlayer = sortedContributions[i];
    const currentCap = currentPlayer.amount;

    // Skip if this player contributed same as previous (already handled)
    if (currentCap === previousCap) continue;

    // Calculate pot for this level
    const perPlayerContribution = currentCap - previousCap;
    const numEligiblePlayers = remainingPlayers.length;
    const potAmount = perPlayerContribution * BigInt(numEligiblePlayers);

    // All remaining players eligible for this pot
    const eligiblePlayerIds = remainingPlayers.map(p => p.userId);

    pots.push({
      potNumber: pots.length,
      amount: potAmount,
      cappedAt: currentCap,
      eligiblePlayerIds,
    });

    logger.info(`Created pot ${pots.length - 1}`, {
      amount: potAmount.toString(),
      cappedAt: currentCap.toString(),
      eligiblePlayers: eligiblePlayerIds.length,
    });

    // Remove this player from remaining (they're all-in at this level)
    remainingPlayers = remainingPlayers.filter(p => p.amount > currentCap);
    previousCap = currentCap;
  }

  logger.info('Side pots calculated', {
    handId,
    numPots: pots.length,
    totalAmount: pots.reduce((sum, p) => sum + p.amount, BigInt(0)).toString(),
  });

  return pots;
}

/**
 * Store side pots in database
 */
export async function storeSidePots(
  tx: any,
  handId: string,
  pots: Array<{
    potNumber: number;
    amount: bigint;
    cappedAt: bigint;
    eligiblePlayerIds: string[];
  }>
) {
  // Delete existing side pots for this hand (in case of recalculation)
  await tx.sidePot.deleteMany({
    where: { handId },
  });

  // Create new side pots
  for (const pot of pots) {
    await tx.sidePot.create({
      data: {
        handId,
        potNumber: pot.potNumber,
        amount: pot.amount,
        cappedAt: pot.cappedAt,
        eligiblePlayerIds: JSON.stringify(pot.eligiblePlayerIds),
      },
    });
  }

  logger.info('Side pots stored', {
    handId,
    numPots: pots.length,
  });
}

/**
 * Get side pots for a hand
 */
export async function getSidePots(tx: any, handId: string) {
  const pots = await tx.sidePot.findMany({
    where: { handId },
    orderBy: { potNumber: 'asc' },
  });

  return pots.map((p: any) => ({
    ...p,
    eligiblePlayerIds: JSON.parse(p.eligiblePlayerIds),
  }));
}
