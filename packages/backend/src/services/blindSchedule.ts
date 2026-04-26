/**
 * Blind escalation schedule.
 * Each level defines small blind and big blind in chip units (6 decimals).
 * Blinds increase every N hands (configurable per game).
 */

export interface BlindLevel {
  smallBlind: bigint;
  bigBlind: bigint;
}

// Default schedule — doubles roughly every level
// Values in raw units (6 decimals: 1 chip = 1_000_000)
const DEFAULT_SCHEDULE: BlindLevel[] = [
  { smallBlind: BigInt(100_000),   bigBlind: BigInt(200_000) },    // 0.10 / 0.20
  { smallBlind: BigInt(200_000),   bigBlind: BigInt(400_000) },    // 0.20 / 0.40
  { smallBlind: BigInt(500_000),   bigBlind: BigInt(1_000_000) },  // 0.50 / 1.00
  { smallBlind: BigInt(1_000_000), bigBlind: BigInt(2_000_000) },  // 1.00 / 2.00
  { smallBlind: BigInt(2_000_000), bigBlind: BigInt(4_000_000) },  // 2.00 / 4.00
  { smallBlind: BigInt(5_000_000), bigBlind: BigInt(10_000_000) }, // 5.00 / 10.00
  { smallBlind: BigInt(10_000_000), bigBlind: BigInt(20_000_000) }, // 10.00 / 20.00
  { smallBlind: BigInt(25_000_000), bigBlind: BigInt(50_000_000) }, // 25.00 / 50.00
];

// Hands per blind level before escalation
const HANDS_PER_LEVEL = 10;

/**
 * Get the blind level for a given level index.
 * If index exceeds schedule, returns the last level.
 */
export function getBlindLevel(levelIndex: number): BlindLevel {
  if (levelIndex >= DEFAULT_SCHEDULE.length) {
    return DEFAULT_SCHEDULE[DEFAULT_SCHEDULE.length - 1];
  }
  return DEFAULT_SCHEDULE[levelIndex];
}

/**
 * Check if blinds should increase, and return the new level if so.
 * Returns null if no change needed.
 */
export function checkBlindIncrease(
  currentLevel: number,
  handsAtLevel: number
): { newLevel: number; blinds: BlindLevel } | null {
  if (handsAtLevel >= HANDS_PER_LEVEL) {
    const newLevel = currentLevel + 1;
    return {
      newLevel,
      blinds: getBlindLevel(newLevel),
    };
  }
  return null;
}

/**
 * Get the full schedule for display purposes.
 */
export function getFullSchedule(): Array<{ level: number; smallBlind: string; bigBlind: string; handsPerLevel: number }> {
  return DEFAULT_SCHEDULE.map((level, index) => ({
    level: index,
    smallBlind: (Number(level.smallBlind) / 1_000_000).toFixed(2),
    bigBlind: (Number(level.bigBlind) / 1_000_000).toFixed(2),
    handsPerLevel: HANDS_PER_LEVEL,
  }));
}
