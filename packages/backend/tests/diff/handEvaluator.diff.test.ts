/**
 * Differential hand-evaluator cross-check vs pokersolver.
 *
 * Goal (Shaun, 2026-05-14): before real money goes live, prove our
 * 7-card hand evaluator agrees with a known-good library (pokersolver)
 * on every hand class AND every winner determination, across a large
 * random sample.
 *
 * Two checks, both 50k hands per run (100k total card evaluations):
 *
 *   1. RANK CLASS: for each random 7-card combo, the rank we output
 *      (high-card / pair / two-pair / ... / royal-flush) must match
 *      the rank pokersolver outputs.
 *
 *   2. WINNER PARITY: for each random 2-player matchup (each player's
 *      2 hole cards + 5 shared board), the winner-set our compareHands()
 *      yields must equal the winner-set pokersolver's Hand.winners()
 *      yields. Ties must agree on both sides.
 *
 * If any disagreement is found we record full details (cards, both rank
 * labels, both winner sets) so we can fix the engine or, if the issue
 * is on pokersolver's side, document why.
 *
 * Cost: ~7-10s wall clock on a workstation. Designed to be runnable as
 * part of `vitest run` but doesn't need to run on every CI tick.
 */

import { describe, it, expect } from 'vitest';
import { Hand as PSHand } from 'pokersolver';
import { evaluateHand, compareHands, type HandRank } from '../../src/services/poker/handEvaluator';
import type { Card, Suit, Rank } from '../../src/services/poker/deck';

// ---------------------------------------------------------------------
//  Card conversion: our domain <-> pokersolver short codes
// ---------------------------------------------------------------------

const SUIT_TO_PS: Record<Suit, string> = {
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
};

const RANK_TO_PS: Record<Rank, string> = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6',
  '7': '7', '8': '8', '9': '9',
  '10': 'T', // pokersolver uses T for 10
  'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A',
};

function toPSCard(c: Card): string {
  return `${RANK_TO_PS[c.rank]}${SUIT_TO_PS[c.suit]}`;
}

// ---------------------------------------------------------------------
//  Rank label normalisation: our names <-> pokersolver names
//  pokersolver's `Hand.name` values (per their source):
//    'Royal Flush', 'Straight Flush', 'Four of a Kind', 'Full House',
//    'Flush', 'Straight', 'Three of a Kind', 'Two Pair', 'Pair', 'High Card'
//  Our HandRank tags are kebab-case keys, mapped here.
// ---------------------------------------------------------------------

const OUR_RANK_TO_LABEL: Record<HandRank, string> = {
  'royal-flush': 'Royal Flush',
  'straight-flush': 'Straight Flush',
  'four-of-a-kind': 'Four of a Kind',
  'full-house': 'Full House',
  'flush': 'Flush',
  'straight': 'Straight',
  'three-of-a-kind': 'Three of a Kind',
  'two-pair': 'Two Pair',
  'pair': 'Pair',
  'high-card': 'High Card',
};

// ---------------------------------------------------------------------
//  Deterministic random card sampling (small xorshift PRNG so we get
//  reproducible failures on rerun)
// ---------------------------------------------------------------------

const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ suit: s, rank: r, value: RANK_VALUE[r] });
    }
  }
  return deck;
}

function makeRng(seed: number) {
  // xorshift32 - cheap, deterministic, plenty of mixing for sampling
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0x100000000);
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function pretty(c: Card): string {
  return `${c.rank}${c.suit[0].toUpperCase()}`;
}

// ---------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------

describe('handEvaluator differential vs pokersolver', () => {
  it('agrees on hand rank class for 50000 random 7-card hands', () => {
    const N = 50_000;
    const rng = makeRng(0x5EED1234);
    const deck = buildDeck();
    const disagreements: Array<{
      idx: number; cards: string[]; ours: string; theirs: string;
    }> = [];

    for (let i = 0; i < N; i++) {
      shuffleInPlace(deck, rng);
      const seven = deck.slice(0, 7);

      // Our evaluator wants holeCards + communityCards (it merges them
      // and finds the best 5-of-7). Split is arbitrary for rank-class
      // checking; we use 2+5 to mirror Hold'em.
      const ours = evaluateHand(seven.slice(0, 2), seven.slice(2));
      const ourLabel = OUR_RANK_TO_LABEL[ours.rank];

      const psHand = PSHand.solve(seven.map(toPSCard));
      // pokersolver labels royal flush under name="Straight Flush" and
      // only distinguishes via descr="Royal Flush". Normalize here so
      // class-level agreement is comparable to our scheme, which has
      // royal-flush as a first-class rank.
      const theirLabel = String(psHand.descr) === 'Royal Flush'
        ? 'Royal Flush'
        : String(psHand.name);

      if (ourLabel !== theirLabel) {
        disagreements.push({
          idx: i,
          cards: seven.map(pretty),
          ours: ourLabel,
          theirs: theirLabel,
        });
        if (disagreements.length >= 20) break; // cap output volume
      }
    }

    if (disagreements.length > 0) {
      const lines = disagreements.map(d =>
        `  [${d.idx}] cards=[${d.cards.join(',')}] ours="${d.ours}" theirs="${d.theirs}"`
      );
      throw new Error(
        `${disagreements.length} rank-class disagreement(s) found vs pokersolver:\n${lines.join('\n')}`
      );
    }
    expect(disagreements.length).toBe(0);
  }, 60_000);

  it('agrees on heads-up winner / tie for 50000 random matchups', () => {
    const N = 50_000;
    const rng = makeRng(0xDEADBEEF);
    const deck = buildDeck();
    const disagreements: Array<{
      idx: number; board: string[]; p1: string[]; p2: string[];
      ours: 'p1' | 'p2' | 'tie'; theirs: 'p1' | 'p2' | 'tie';
      oursLabel: string; theirsLabel: string;
    }> = [];

    for (let i = 0; i < N; i++) {
      shuffleInPlace(deck, rng);
      const p1Hole = deck.slice(0, 2);
      const p2Hole = deck.slice(2, 4);
      const board = deck.slice(4, 9);

      // Ours
      const h1 = evaluateHand(p1Hole, board);
      const h2 = evaluateHand(p2Hole, board);
      const cmp = compareHands(h1, h2);
      const ours: 'p1' | 'p2' | 'tie' = cmp > 0 ? 'p1' : cmp < 0 ? 'p2' : 'tie';

      // pokersolver winners() takes an array of solved hands; returns
      // the subset that wins (length>1 == tie).
      const psP1 = PSHand.solve([...p1Hole, ...board].map(toPSCard));
      const psP2 = PSHand.solve([...p2Hole, ...board].map(toPSCard));
      const winners = PSHand.winners([psP1, psP2]);
      let theirs: 'p1' | 'p2' | 'tie';
      if (winners.length === 2) theirs = 'tie';
      else if (winners[0] === psP1) theirs = 'p1';
      else theirs = 'p2';

      if (ours !== theirs) {
        disagreements.push({
          idx: i,
          board: board.map(pretty),
          p1: p1Hole.map(pretty),
          p2: p2Hole.map(pretty),
          ours, theirs,
          oursLabel: `${OUR_RANK_TO_LABEL[h1.rank]} vs ${OUR_RANK_TO_LABEL[h2.rank]}`,
          theirsLabel: `${String(psP1.name)} vs ${String(psP2.name)}`,
        });
        if (disagreements.length >= 20) break;
      }
    }

    if (disagreements.length > 0) {
      const lines = disagreements.map(d =>
        `  [${d.idx}] board=[${d.board.join(',')}] p1=[${d.p1.join(',')}] p2=[${d.p2.join(',')}]\n` +
        `       ours=${d.ours} (${d.oursLabel})  theirs=${d.theirs} (${d.theirsLabel})`
      );
      throw new Error(
        `${disagreements.length} winner-parity disagreement(s) found vs pokersolver:\n${lines.join('\n')}`
      );
    }
    expect(disagreements.length).toBe(0);
  }, 60_000);
});
