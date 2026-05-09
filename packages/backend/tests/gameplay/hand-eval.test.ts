/**
 * Layer B — hand evaluator edge cases (driven via scripted gameplay).
 *
 * Each scenario forces a specific deck so we can assert exact hand-vs-hand
 * outcomes. The point: stress `evaluateHand` and `compareHands` through
 * the live engine path (showdown), not just unit tests.
 *
 * Cases covered:
 *   - Flush beats straight
 *   - Full house beats flush
 *   - Quads beat full house
 *   - Straight flush beats quads
 *   - Higher full house beats lower
 *   - Pair vs pair: kicker chain
 *   - Two pair vs two pair: top pair, then second pair, then kicker
 *   - Wheel straight (A-2-3-4-5) is the LOWEST straight
 *   - Ace-high straight beats king-high straight
 *   - Flush: highest card wins regardless of suit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScripted } from './dsl';
import { setForcedDeck, clearForcedDeck, buildPartialDeck } from './forcedDeck';

vi.mock('../../src/db/client', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, prop) => {
        const w: any = (globalThis as any).__t3PokerSimWorld;
        if (!w) throw new Error('sim world not installed');
        return w[prop as string];
      },
    }
  ),
}));
vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 500_000n, bigBlind: 1_000_000n }),
}));
vi.mock('../../src/socket', () => ({
  emitGameEvent: vi.fn(),
  emitBalanceUpdate: vi.fn(),
  broadcastGameState: vi.fn(),
  checkGameRoomJoin: vi.fn(),
}));
vi.mock('../../src/services/poker/deck', async (importOriginal) => {
  const real = await importOriginal<any>();
  const helper = await import('./forcedDeck');
  return {
    ...real,
    shuffleDeck: (deck: any[]) => {
      const forced = helper.getActiveForcedDeck();
      if (forced) return [...forced];
      return real.shuffleDeck(deck);
    },
  };
});

function assertScriptedOk(name: string, r: Awaited<ReturnType<typeof runScripted>>) {
  if (r.ok) return;
  const lines: string[] = [
    `Scripted run [${name}] FAILED: ${r.failureSummary ?? 'see violations'}`,
    `Ended reason: ${r.report.endedReason}`,
    ...(r.report.error ? [`Error: ${r.report.error}`] : []),
    ...(r.report.failure ? [`Failure: ${JSON.stringify(r.report.failure, null, 2)}`] : []),
    ...(r.invariantViolations.length
      ? [`Invariants: ${r.invariantViolations.map((v) => `[${v.id}] ${v.message}`).join(' | ')}`]
      : []),
    `FinalStacks: ${JSON.stringify(r.report.finalStacks.map((s) => ({ uid: s.userId, chips: Number(s.chipStack) / 1_000_000 })))}`,
    `FinalBalances: ${JSON.stringify(r.report.finalBalances.map((s) => ({ uid: s.userId, chips: Number(s.chips) / 1_000_000 })))}`,
    `Hands: ${r.report.hands.length}`,
  ];
  throw new Error(lines.join('\n'));
}

/**
 * Heads-up showdown helper. Forces deck so P0/P1 get exact hole cards
 * and board is exact. Both call/check down. Pot = 2 chips (1 each).
 * Asserts winner via finalStacks.
 *
 * Engine deal order (no burns): P0 cards 0+1, P1 cards 2+3, flop 4-6,
 * turn 7, river 8.
 */
async function huShowdown(opts: {
  name: string;
  p0Hole: [string, string];
  p1Hole: [string, string];
  board: [string, string, string, string, string];
  expectWinner: 'P0' | 'P1' | 'split';
}) {
  setForcedDeck(
    buildPartialDeck([
      opts.p0Hole[0], opts.p0Hole[1],
      opts.p1Hole[0], opts.p1Hole[1],
      opts.board[0], opts.board[1], opts.board[2],
      opts.board[3],
      opts.board[4],
    ])
  );
  const r = await runScripted({
    name: opts.name,
    players: 2,
    stacks: [200, 200],
    hands: [
      {
        preflop: [
          { actor: 'SB', action: 'call' },
          { actor: 'BB', action: 'check' },
        ],
        flop: [{ actor: 'BB', action: 'check' }, { actor: 'SB', action: 'check' }],
        turn: [{ actor: 'BB', action: 'check' }, { actor: 'SB', action: 'check' }],
        river: [{ actor: 'BB', action: 'check' }, { actor: 'SB', action: 'check' }],
      },
    ],
    expect: {
      handsCompleted: 1,
      finalStacks:
        opts.expectWinner === 'P0'
          ? [201, 199]
          : opts.expectWinner === 'P1'
            ? [199, 201]
            : [200, 200],
    },
  });
  assertScriptedOk(opts.name, r);
}

describe('Layer B — hand evaluator edge cases', () => {
  beforeEach(() => {
    clearForcedDeck();
  });

  it('HE-01: flush beats straight', async () => {
    // P0 makes 6-7-8-9-T straight (mixed suits).
    // P1 makes A-high spade flush.
    // Board: 7d 8h Ts 5s 2s. (3 spades on board)
    // P0 hole: 9c 6h → plays 6-7-8-9-T straight from 6h+9c+7d+8h+Ts.
    // P1 hole: As Ks → both spades; with 5s+2s+Ts on board = 5 spades = flush.
    //   P1 plays A K T 5 2 spade flush (wait, A-K-T-5-2 is just an A-high flush).
    // Flush > straight.
    await huShowdown({
      name: 'HE-01_flush_beats_straight',
      p0Hole: ['9c', '6h'],
      p1Hole: ['As', 'Ks'],
      board: ['7d', '8h', 'Ts', '5s', '2s'],
      expectWinner: 'P1',
    });
  });

  it('HE-02: full house beats flush', async () => {
    // P0 makes A-high heart flush.
    // P1 makes full house (set of 7s + pair of 5s).
    // Board: 7s 7d 5h 2h Ah.
    // P0 hole: Kh Qh → 4 hearts in hand+board (Kh Qh 5h 2h Ah) = A-K-Q-5-2 flush.
    // P1 hole: 7c 5c → 7c+7s+7d = trips of 7s, plus 5c+5h = pair of 5s. Full house 7s over 5s.
    // Full house > flush.
    await huShowdown({
      name: 'HE-02_full_house_beats_flush',
      p0Hole: ['Kh', 'Qh'],
      p1Hole: ['7c', '5c'],
      board: ['7s', '7d', '5h', '2h', 'Ah'],
      expectWinner: 'P1',
    });
  });

  it('HE-03: quads beat full house', async () => {
    // P0: full house (Kx + pair).
    // P1: quad 7s.
    // Board: 7c 7h 7d Kc Ks.
    // P0 hole: Ks Kh → wait Ks already on board. Use Kd + Ah.
    //   Actually P0 has 4 kings on board (Kc Ks + 2 in hole would conflict).
    //   Board has Kc and Ks. So if P0 has Kd and Kh, that's 4 kings.
    //   But that's quads of kings, not full house. Need to give P0 fewer kings.
    // Adjust: P0 hole: Ad As → board 7c 7h 7d Kc Ks. P0 plays AA + KK + 7? No 5-card best.
    //   AA + 7-7-K = full house aces over 7s. (A-A-7-7-7? No, 3+2 = 5 cards.) Best 5 from
    //   Ad As 7c 7h 7d Kc Ks: A-A-K-K-7 (two pair plus kicker), but better is full house
    //   A-A-A... only 2 aces. Best full house: 7-7-7-A-A (set of 7s with pair of As).
    //   Trips of 7s with pair of aces over kings? Can also do A-A-K-K-7 (two pair).
    //   Full house 7-7-7-A-A vs full house 7-7-7-K-K. The full house with 7s as trips
    //   uses pair from hole/board. Best for P0: 7s as trips (3 sevens), top pair from
    //   remaining (A-A from hole). So P0 has 7-7-7-A-A.
    // P1 hole: 7s + anything-not-7. Wait — board already has 7c 7h 7d. P1 only needs
    //   one more 7 for quads. But there's only one 7 left in the deck (7s) and it's
    //   on the board if we put it there.
    // Adjust: don't put 7s on board. Use 7c 7h 7d on board, give P1 the 7s as hole card.
    // Then P0 can NOT have 4 sevens (they have non-7 hole). P1 has 4 sevens.
    // P0 best: AA + 7-7-7 = full house aces over 7s (or 7-7-7-A-A).
    // P1: 7-7-7-7-K (quads with K kicker).
    // Quads > full house.
    await huShowdown({
      name: 'HE-03_quads_beat_full_house',
      p0Hole: ['Ad', 'As'],
      p1Hole: ['7s', '2c'],
      board: ['7c', '7h', '7d', 'Kc', 'Ks'],
      expectWinner: 'P1',
    });
  });

  it('HE-04: straight flush beats quads', async () => {
    // P0 makes quads.
    // P1 makes straight flush.
    // Board: 5s 6s 7s 8s Ks.
    // P0 hole: Kc Kd → board Ks Kc Kd Ks ... wait Ks on board only once. P0 has Kc Kd
    //   + Ks on board = 3 kings. Not quads.
    // Adjust: put Kc and Ks on board. P0 has Kd + Kh = quad kings.
    // Board: 5s 6s 7s Kc Ks. P0 hole: Kd Kh → 4 kings. P1 hole: 8s 9s → 5-6-7-8-9 spade
    //   straight flush.
    // But board only has 3 spades; P1 needs 5s+6s+7s + 8s+9s (hole) = 5 spades, all
    // consecutive 5-9. Straight flush.
    // P0: 4 kings + any 5th card (5 from board) = quads with 5 kicker.
    // Straight flush > quads.
    await huShowdown({
      name: 'HE-04_straight_flush_beats_quads',
      p0Hole: ['Kd', 'Kh'],
      p1Hole: ['8s', '9s'],
      board: ['5s', '6s', '7s', 'Kc', 'Ks'],
      expectWinner: 'P1',
    });
  });

  it('HE-05: higher full house beats lower (kings full vs queens full)', async () => {
    // Board: K Q K Q 2 (mixed suits, no flush).
    // P0 hole: Kh + 2c → 3 kings (KK + KK from board) + ? Wait, only 2 K on board.
    //   Adjust board to KK+QQ+x.
    // Board: Kc Kh Qd Qs 5h.
    // P0 hole: Kd 5c → 3 kings (Kc Kh Kd) + pair from… need 5h+5c=2 fives, but 5h on
    //   board + 5c hole = pair of 5s. But best 5 cards: KKK + QQ = K full of Q? No,
    //   K K K Q Q = full house kings full of queens (KKKQQ).
    // Actually any holding with 3 K's makes K-full-of-Q regardless. P0 hole Kd + junk.
    // P1 hole: Qc + junk → 3 queens (Qc Qd Qs) + pair from board K-K = full house Q-full-K.
    // Kings full of queens > Queens full of kings.
    await huShowdown({
      name: 'HE-05_higher_full_house',
      p0Hole: ['Kd', '7h'],
      p1Hole: ['Qc', '8h'],
      board: ['Kc', 'Kh', 'Qd', 'Qs', '5h'],
      expectWinner: 'P0',
    });
  });

  it('HE-06: pair vs pair — kicker chain (top, then second, then third)', async () => {
    // Both have pair of aces. Differentiate by kicker.
    // Board: As Ac 7d 5h 2c (pair of aces + low cards, no flush, no straight).
    // P0 hole: Kd Qh → A-A-K-Q-7.
    // P1 hole: Kc Jd → A-A-K-J-7.
    // Same top pair, same first kicker (K), second kicker Q vs J. P0 wins.
    await huShowdown({
      name: 'HE-06_pair_kicker_chain',
      p0Hole: ['Kd', 'Qh'],
      p1Hole: ['Kc', 'Jd'],
      board: ['As', 'Ac', '7d', '5h', '2c'],
      expectWinner: 'P0',
    });
  });

  it('HE-07: two pair vs two pair — top pair tiebreak', async () => {
    // P0 makes two pair: aces and threes.
    // P1 makes two pair: kings and threes.
    // Board: 3s 3d Ah Kc 7h.
    // P0 hole: Ad 9c → A-A-3-3-K (aces and threes, K kicker).
    // P1 hole: Ks 2c → K-K-3-3-A (kings and threes, A kicker).
    // P0's higher top pair (aces) wins.
    await huShowdown({
      name: 'HE-07_two_pair_top_pair_tiebreak',
      p0Hole: ['Ad', '9c'],
      p1Hole: ['Ks', '2c'],
      board: ['3s', '3d', 'Ah', 'Kc', '7h'],
      expectWinner: 'P0',
    });
  });

  it('HE-08: wheel straight (A-2-3-4-5) is the LOWEST straight', async () => {
    // P0 has A-2 → wheel.
    // P1 has 2-6 → 2-3-4-5-6 straight (one rank higher than wheel).
    // Board: 3 4 5 K Q.
    // P0: A-2-3-4-5 = wheel.
    // P1: 2-3-4-5-6 = six-high straight.
    // Six-high > wheel. P1 wins.
    await huShowdown({
      name: 'HE-08_wheel_is_lowest_straight',
      p0Hole: ['As', '2h'],
      p1Hole: ['2s', '6h'],
      // Wait: both have 2. P0 has 2h, P1 has 2s. Different suits, both 2s. Allowed.
      board: ['3d', '4c', '5d', 'Kc', 'Qh'],
      expectWinner: 'P1',
    });
  });

  it('HE-09: ace-high straight beats king-high straight', async () => {
    // Board: T J Q K + low.
    // P0 has Ad → A-K-Q-J-T = ace-high straight (broadway).
    // P1 has 9c → 9-T-J-Q-K = king-high straight.
    // Broadway > king-high.
    // Board needs to have T J Q K (4 connectors) plus a 5th card.
    // Board: Td Jc Qd Kh 2c.
    // P0 hole: Ad + 5h → broadway with A.
    // P1 hole: 9c + 4h → 9-T-J-Q-K straight.
    await huShowdown({
      name: 'HE-09_broadway_beats_king_high',
      p0Hole: ['Ad', '5h'],
      p1Hole: ['9c', '4h'],
      board: ['Td', 'Jc', 'Qd', 'Kh', '2c'],
      expectWinner: 'P0',
    });
  });

  it('HE-10: flush — highest card wins regardless of suit', async () => {
    // Both make flushes from board's 3 spades + their 2 hole spades.
    // Board: 4s 6s 9s Kh 2c (3 spades).
    // P0 hole: As 7s → A-9-7-6-4 spade flush.
    // P1 hole: Ks 8s → K-9-8-6-4 spade flush.
    // Wait: Kh is on board. P1 has Ks (different suit, but only 1 spade on board adds to P1).
    //   P1 actually has Ks (spade) + 8s + 9s (board) + 6s + 4s = 5 spades = K-9-8-6-4 flush.
    //   P0 has As + 7s + 9s + 6s + 4s = A-9-7-6-4 spade flush.
    //   A-high > K-high. P0 wins.
    await huShowdown({
      name: 'HE-10_flush_top_card',
      p0Hole: ['As', '7s'],
      p1Hole: ['Ks', '8s'],
      board: ['4s', '6s', '9s', 'Kh', '2c'],
      expectWinner: 'P0',
    });
  });
});
