/**
 * Forced-deck helper for deterministic gameplay tests.
 *
 * Per Gerald's audit-20 Q1 verdict: prefer test-side mocking via vi.mock,
 * keep production shuffle code untouched, validate forced decks for 52
 * unique cards.
 *
 * Usage in a test file:
 *   vi.mock('../../src/services/poker/deck', async (importOriginal) => {
 *     const real = await importOriginal<any>();
 *     return {
 *       ...real,
 *       // shuffleDeck returns whatever the active forced deck says.
 *       shuffleDeck: (_deck: any) => getActiveForcedDeck() ?? real.shuffleDeck(_deck),
 *     };
 *   });
 *
 * Then in the test body:
 *   setForcedDeck(buildDeck([
 *     'AsKs', 'AhKh',          // hole cards: P1 hole 1, P2 hole 1
 *     'AdKd', 'AcKc',          // hole cards: P1 hole 2, P2 hole 2
 *     '2c',                    // burn (engine consumes a burn before flop in real games)
 *     'Qs', 'Js', 'Ts',        // flop
 *     '3c',                    // burn
 *     '9s',                    // turn
 *     '4c',                    // burn
 *     '8s',                    // river
 *     ...rest52
 *   ]));
 *
 * The validator REJECTS decks that are not exactly 52 unique cards from
 * the standard 52-card universe — so a typo can never accidentally
 * produce a "duplicate ace" hand.
 */

import type { Card, Rank, Suit } from '../../src/services/poker/deck';

const SUITS: Record<string, Suit> = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
const RANKS: Record<string, Rank> = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  'T': '10', '10': '10', 'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A',
};
const RANK_VALUE: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

function parseCard(raw: string): Card {
  // Accept "As", "10s", "Ts" style.
  const trimmed = raw.trim();
  let rankStr: string;
  let suitChar: string;
  if (trimmed.length === 3) {
    rankStr = trimmed.slice(0, 2);
    suitChar = trimmed.slice(2, 3).toLowerCase();
  } else if (trimmed.length === 2) {
    rankStr = trimmed.slice(0, 1).toUpperCase();
    suitChar = trimmed.slice(1, 2).toLowerCase();
  } else {
    throw new Error(`forcedDeck: bad card '${raw}' (expected formats like 'As', 'Ts', '10s')`);
  }
  const rank = RANKS[rankStr.toUpperCase()] ?? RANKS[rankStr];
  const suit = SUITS[suitChar];
  if (!rank || !suit) {
    throw new Error(`forcedDeck: bad card '${raw}'`);
  }
  return { rank, suit, value: RANK_VALUE[rank] };
}

export function buildDeck(cards: string[]): Card[] {
  if (cards.length !== 52) {
    throw new Error(`forcedDeck: must be exactly 52 cards, got ${cards.length}`);
  }
  const parsed = cards.map(parseCard);
  // Reject duplicates.
  const seen = new Set<string>();
  for (const c of parsed) {
    const key = `${c.rank}${c.suit}`;
    if (seen.has(key)) {
      throw new Error(`forcedDeck: duplicate card '${key}'`);
    }
    seen.add(key);
  }
  return parsed;
}

/** Convenience: a deck where the listed cards come first, then the
 *  remaining cards fill in deterministic order. Lets tests focus only
 *  on the cards that matter for their assertion. */
export function buildPartialDeck(prefix: string[]): Card[] {
  const used = new Set<string>();
  const head: Card[] = [];
  for (const raw of prefix) {
    const c = parseCard(raw);
    const key = `${c.rank}${c.suit}`;
    if (used.has(key)) throw new Error(`forcedDeck: duplicate card '${key}' in prefix`);
    used.add(key);
    head.push(c);
  }
  // Fill remainder in canonical (rank, suit) order, skipping cards already used.
  const allRanks: Rank[] = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const allSuits: Suit[] = ['hearts','diamonds','clubs','spades'];
  const tail: Card[] = [];
  for (const r of allRanks) {
    for (const s of allSuits) {
      const key = `${r}${s}`;
      if (used.has(key)) continue;
      tail.push({ rank: r, suit: s, value: RANK_VALUE[r] });
    }
  }
  return [...head, ...tail];
}

// ---- Active-deck registry (set per test) ----

let _active: Card[] | null = null;
export function setForcedDeck(deck: Card[] | null) { _active = deck; }
export function getActiveForcedDeck(): Card[] | null { return _active; }
export function clearForcedDeck() { _active = null; }
