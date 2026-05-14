import { Card } from './deck';

export type HandRank =
  | 'high-card'
  | 'pair'
  | 'two-pair'
  | 'three-of-a-kind'
  | 'straight'
  | 'flush'
  | 'full-house'
  | 'four-of-a-kind'
  | 'straight-flush'
  | 'royal-flush';

export interface HandResult {
  rank: HandRank;
  rankValue: number; // 1-10 for comparison
  cards: Card[]; // Best 5 cards
  tiebreakers: number[]; // For comparing same rank hands
  description: string;
}

const HAND_RANK_VALUES: Record<HandRank, number> = {
  'high-card': 1,
  'pair': 2,
  'two-pair': 3,
  'three-of-a-kind': 4,
  'straight': 5,
  'flush': 6,
  'full-house': 7,
  'four-of-a-kind': 8,
  'straight-flush': 9,
  'royal-flush': 10,
};

/**
 * Convert a card value (2..14) to its human-readable name. Used to
 * build descriptive hand names like "Pair of Aces" instead of just
 * "Pair".
 *
 * Plural form (e.g. for "Pair of 7s") just appends an 's' to the rank
 * name; for face cards we use the standard poker plurals ("Aces",
 * "Kings", "Queens", "Jacks").
 */
function rankName(value: number, plural: boolean = false): string {
  switch (value) {
    case 14: return plural ? 'Aces' : 'Ace';
    case 13: return plural ? 'Kings' : 'King';
    case 12: return plural ? 'Queens' : 'Queen';
    case 11: return plural ? 'Jacks' : 'Jack';
    case 10: return plural ? '10s' : '10';
    default: return plural ? `${value}s` : `${value}`;
  }
}

/**
 * Evaluate the best 5-card poker hand from 7 cards
 */
export function evaluateHand(holeCards: Card[], communityCards: Card[]): HandResult {
  const allCards = [...holeCards, ...communityCards];
  
  // Generate all 5-card combinations
  const combinations = getCombinations(allCards, 5);
  
  // Evaluate each combination
  let bestHand: HandResult | null = null;
  
  for (const combo of combinations) {
    const hand = evaluateFiveCards(combo);
    if (!bestHand || compareHands(hand, bestHand) > 0) {
      bestHand = hand;
    }
  }
  
  return bestHand!;
}

/**
 * Generate all k-combinations from array
 */
function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, k - 1).map(combo => [first, ...combo]);
  const withoutFirst = getCombinations(rest, k);
  
  return [...withFirst, ...withoutFirst];
}

/**
 * Evaluate a specific 5-card hand
 */
function evaluateFiveCards(cards: Card[]): HandResult {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  
  // Check for flush
  const isFlush = cards.every(c => c.suit === cards[0].suit);
  
  // Check for straight
  const values = sorted.map(c => c.value);
  const isStraight = checkStraight(values);
  
  // Special case: A-2-3-4-5 straight (wheel)
  const isWheelStraight = values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2;
  
  // Count ranks
  const rankCounts = new Map<number, number>();
  for (const card of sorted) {
    rankCounts.set(card.value, (rankCounts.get(card.value) || 0) + 1);
  }
  
  const counts = Array.from(rankCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]; // Sort by count descending
      return b[0] - a[0]; // Then by value descending
    });
  
  // Royal flush
  if (isFlush && isStraight && values[0] === 14 && values[4] === 10) {
    return {
      rank: 'royal-flush',
      rankValue: HAND_RANK_VALUES['royal-flush'],
      cards: sorted,
      tiebreakers: [],
      description: 'Royal Flush',
    };
  }
  
  // Straight flush
  if (isFlush && (isStraight || isWheelStraight)) {
    return {
      rank: 'straight-flush',
      rankValue: HAND_RANK_VALUES['straight-flush'],
      cards: sorted,
      tiebreakers: isWheelStraight ? [5] : [values[0]],
      description: 'Straight Flush',
    };
  }
  
  // Four of a kind
  if (counts[0][1] === 4) {
    return {
      rank: 'four-of-a-kind',
      rankValue: HAND_RANK_VALUES['four-of-a-kind'],
      cards: sorted,
      tiebreakers: [counts[0][0], counts[1][0]],
      description: `Four ${rankName(counts[0][0], true)}`,
    };
  }
  
  // Full house
  if (counts[0][1] === 3 && counts[1][1] === 2) {
    return {
      rank: 'full-house',
      rankValue: HAND_RANK_VALUES['full-house'],
      cards: sorted,
      tiebreakers: [counts[0][0], counts[1][0]],
      description: `Full House, ${rankName(counts[0][0], true)} over ${rankName(counts[1][0], true)}`,
    };
  }
  
  // Flush
  if (isFlush) {
    return {
      rank: 'flush',
      rankValue: HAND_RANK_VALUES['flush'],
      cards: sorted,
      tiebreakers: values,
      description: `Flush, ${rankName(values[0])}-high`,
    };
  }
  
  // Straight
  if (isStraight || isWheelStraight) {
    const highCard = isWheelStraight ? 5 : values[0];
    return {
      rank: 'straight',
      rankValue: HAND_RANK_VALUES['straight'],
      cards: sorted,
      tiebreakers: isWheelStraight ? [5] : [values[0]],
      description: `Straight, ${rankName(highCard)}-high`,
    };
  }
  
  // Three of a kind
  if (counts[0][1] === 3) {
    return {
      rank: 'three-of-a-kind',
      rankValue: HAND_RANK_VALUES['three-of-a-kind'],
      cards: sorted,
      tiebreakers: [counts[0][0], counts[1][0], counts[2][0]],
      description: `Three ${rankName(counts[0][0], true)}`,
    };
  }
  
  // Two pair
  if (counts[0][1] === 2 && counts[1][1] === 2) {
    return {
      rank: 'two-pair',
      rankValue: HAND_RANK_VALUES['two-pair'],
      cards: sorted,
      tiebreakers: [counts[0][0], counts[1][0], counts[2][0]],
      description: `Two Pair, ${rankName(counts[0][0], true)} and ${rankName(counts[1][0], true)}`,
    };
  }
  
  // Pair
  if (counts[0][1] === 2) {
    return {
      rank: 'pair',
      rankValue: HAND_RANK_VALUES['pair'],
      cards: sorted,
      tiebreakers: [counts[0][0], counts[1][0], counts[2][0], counts[3][0]],
      description: `Pair of ${rankName(counts[0][0], true)}, ${rankName(counts[1][0])} kicker`,
    };
  }
  
  // High card
  return {
    rank: 'high-card',
    rankValue: HAND_RANK_VALUES['high-card'],
    cards: sorted,
    tiebreakers: values,
    description: `${rankName(values[0])} high`,
  };
}

/**
 * Check if values form a straight
 */
function checkStraight(values: number[]): boolean {
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] - values[i + 1] !== 1) {
      return false;
    }
  }
  return true;
}

/**
 * Compare two hands
 * Returns: 1 if hand1 wins, -1 if hand2 wins, 0 if tie
 */
export function compareHands(hand1: HandResult, hand2: HandResult): number {
  // Compare rank
  if (hand1.rankValue !== hand2.rankValue) {
    return hand1.rankValue > hand2.rankValue ? 1 : -1;
  }
  
  // Same rank, compare tiebreakers
  for (let i = 0; i < Math.max(hand1.tiebreakers.length, hand2.tiebreakers.length); i++) {
    const t1 = hand1.tiebreakers[i] || 0;
    const t2 = hand2.tiebreakers[i] || 0;
    
    if (t1 !== t2) {
      return t1 > t2 ? 1 : -1;
    }
  }
  
  return 0; // Tie
}
