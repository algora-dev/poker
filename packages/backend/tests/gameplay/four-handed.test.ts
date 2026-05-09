/**
 * Layer B — 4-handed gameplay scenarios.
 *
 * Targets:
 *   - BB option after multiple limpers
 *   - Min-raise exactly equal to prior raise increment
 *   - Re-raise above the prior increment that DOES reopen action
 *   - Position rotation across multiple hands
 *   - 4-way all-in producing 3 side pots
 *   - Walk preflop with multiple seats folding
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

// In 4-handed, positions clockwise from dealer are: BTN, SB, BB, UTG.
// Preflop first-to-act = UTG (next after BB). Order: UTG, BTN, SB, BB.
// Postflop first-to-act = SB (next after dealer). Order: SB, BB, UTG, BTN.

describe('Layer B — 4-handed scenarios', () => {
  beforeEach(() => {
    clearForcedDeck();
  });

  it('FH-01: walk-around preflop — UTG, BTN, SB all fold; BB collects blinds', async () => {
    const r = await runScripted({
      name: 'FH-01_walk_around',
      players: 4,
      stacks: [200, 200, 200, 200],
      hands: [
        {
          // dealer = seat 0. SB=1, BB=2, UTG=3.
          // Preflop order: UTG, BTN, SB.
          preflop: [
            { actor: 'UTG', action: 'fold' },
            { actor: 'BTN', action: 'fold' },
            { actor: 'SB',  action: 'fold' },
            // BB takes 1.5 chips uncontested.
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Seats: 0=BTN, 1=SB, 2=BB, 3=UTG.
        // BTN: 200 (no chips committed), SB: -0.5, BB: +0.5, UTG: 200.
        finalStacks: [200, 199.5, 200.5, 200],
      },
    });
    assertScriptedOk('FH-01', r);
  });

  it('FH-02: BB option after multiple limpers — UTG limps, BTN limps, SB calls, BB checks option, all check down', async () => {
    setForcedDeck(
      buildPartialDeck([
        // hole cards (deal order: seat 0, 0, then 1, 1, then 2, 2, then 3, 3)
        '2c', '3c',          // seat 0 (BTN)
        '4c', '5c',          // seat 1 (SB)
        '6c', '7c',          // seat 2 (BB)
        '8c', '9c',          // seat 3 (UTG)
        // board: KKK QQ -> all 4 play KKKQQ off the board, 4-way split.
        'Ks', 'Kh', 'Kd',
        'Qs',
        'Qd',
      ])
    );
    const r = await runScripted({
      name: 'FH-02_bb_option_multi_limp',
      players: 4,
      stacks: [200, 200, 200, 200],
      hands: [
        {
          // Preflop order: UTG, BTN, SB, BB.
          preflop: [
            { actor: 'UTG', action: 'call' },   // limp 1
            { actor: 'BTN', action: 'call' },   // limp 1
            { actor: 'SB',  action: 'call' },   // call 0.5 more (already 0.5 in)
            { actor: 'BB',  action: 'check' },  // BB option exercised
          ],
          // Postflop order: SB, BB, UTG, BTN.
          flop: [
            { actor: 'SB',  action: 'check' },
            { actor: 'BB',  action: 'check' },
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
          turn: [
            { actor: 'SB',  action: 'check' },
            { actor: 'BB',  action: 'check' },
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
          river: [
            { actor: 'SB',  action: 'check' },
            { actor: 'BB',  action: 'check' },
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot = 4 chips (1 each). Board KKK QQ → all play full house KKKQQ.
        // 4-way split: 1 each. Net 0 for everyone.
        finalStacks: [200, 200, 200, 200],
      },
    });
    assertScriptedOk('FH-02', r);
  });

  it('FH-03: min-raise exactly equal to prior raise increment is legal', async () => {
    // UTG opens to 3 (increment 2 over the 1 BB).
    // BTN min-raises to 5 (increment exactly 2 = same as prior).
    // SB folds, BB calls 5, UTG calls 5.
    // Flop checked down to river, no further action.
    setForcedDeck(
      buildPartialDeck([
        '2c', '3c',          // BTN: junk
        '4c', '5c',          // SB: junk (folds anyway)
        '6c', '7c',          // BB: junk
        '8c', '9c',          // UTG: junk
        // Board chosen to be a 5-card straight flush (5-9 spades) → 3-way split.
        '5s', '6s', '7s',
        '8s',
        '9s',
      ])
    );
    const r = await runScripted({
      name: 'FH-03_min_raise_equal_prior',
      players: 4,
      stacks: [200, 200, 200, 200],
      hands: [
        {
          preflop: [
            { actor: 'UTG', action: 'raise', amount: 3 },  // open to 3 (increment 2)
            { actor: 'BTN', action: 'raise', amount: 5 },  // min-raise to 5 (increment 2 — exactly equal to prior)
            { actor: 'SB',  action: 'fold' },
            { actor: 'BB',  action: 'call' },              // call 5 (4 more)
            { actor: 'UTG', action: 'call' },              // call 5 (2 more)
          ],
          flop: [
            { actor: 'BB',  action: 'check' },
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
          turn: [
            { actor: 'BB',  action: 'check' },
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
          river: [
            { actor: 'BB',  action: 'check' },
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot = 5 + 5 + 5 + 0.5 (SB blind, folded) = 15.5 chips.
        // Board makes straight flush 5-9 spades → all 3 active play it.
        // 3-way split: 15.5 / 3 = 5.166... With micro-units: 15500000 / 3 =
        // 5166666 each, remainder 2 micros. Remainder goes to first
        // winning seat clockwise from dealer.
        // BTN=0, SB=1(folded), BB=2, UTG=3. Clockwise from BTN: SB, BB, UTG, BTN.
        // First WINNING seat CW from BTN: SB folded, so BB.
        // BB gets 5166666 + 2 = 5166668 micros = 5.166668 chips.
        // Others: 5166666 micros each = 5.166666 chips.
        // Final stacks (chips):
        //   BTN: 200 - 5 + 5.166666 = 200.166666
        //   SB:  200 - 0.5 = 199.5
        //   BB:  200 - 5 + 5.166668 = 200.166668
        //   UTG: 200 - 5 + 5.166666 = 200.166666
        // (We assert at micro-precision via raw values, but convert to
        // chips. Use loose float equality? Better: avoid odd-chip
        // remainders by using a pot divisible by 3.)
        // Easier path: just assert the sum is conserved and skip exact
        // per-seat. But Gerald's "100% no flake" demands exact.
        // We accept the odd-chip math as documented above.
        finalStacks: [200.166666, 199.5, 200.166668, 200.166666],
      },
    });
    assertScriptedOk('FH-03', r);
  });

  it('FH-04: full re-raise reopens action; original raiser may 4-bet', async () => {
    setForcedDeck(
      buildPartialDeck([
        // Hole cards
        '2c', '3c',          // BTN
        '4c', '5c',          // SB
        '6c', '7c',          // BB (folds)
        'As', 'Ad',          // UTG: pocket aces
        // Board: pocket-aces wins (no helpful board cards beyond what they have)
        // Use board 5d 6h 7s 8h 2d (no flush/straight matches).
        '5d', '6h', '7s',
        '8h',
        '2d',
      ])
    );
    const r = await runScripted({
      name: 'FH-04_full_reraise_reopens',
      players: 4,
      stacks: [200, 200, 200, 200],
      hands: [
        {
          preflop: [
            { actor: 'UTG', action: 'raise', amount: 4 },   // open to 4 (increment 3)
            { actor: 'BTN', action: 'raise', amount: 12 },  // 3-bet to 12 (increment 8 — full)
            { actor: 'SB',  action: 'fold' },
            { actor: 'BB',  action: 'fold' },
            // Action returns to UTG. Full re-raise reopens; UTG can 4-bet, call, or fold.
            { actor: 'UTG', action: 'raise', amount: 30 },  // 4-bet to 30 (increment 18 — full)
            { actor: 'BTN', action: 'call' },               // call 30
          ],
          flop: [
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
          turn: [
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
          river: [
            { actor: 'UTG', action: 'check' },
            { actor: 'BTN', action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot = 30 + 30 + 0.5 (SB) + 1 (BB) = 61.5.
        // UTG has AA, BTN has 2c3c. Board 5d 6h 7s 8h 2d.
        // UTG plays AA + best 3 from board → A-A-8-7-6 (pair of aces, 8 kicker).
        // BTN plays best 5 from 2c 3c 5d 6h 7s 8h 2d.
        //   The straight 5-6-7-8 + (need a 4 or a 9). No straight.
        //   Pair of 2s (2c + 2d) + best kickers 8-7-6.
        // UTG pair of aces beats BTN pair of 2s. UTG wins entire 61.5 pot.
        // BTN: 200 - 30 = 170.
        // SB:  200 - 0.5 = 199.5.
        // BB:  200 - 1 = 199.
        // UTG: 200 - 30 + 61.5 = 231.5.
        finalStacks: [170, 199.5, 199, 231.5],
      },
    });
    assertScriptedOk('FH-04', r);
  });

  it('FH-05: 4-way all-in confrontation creates 3 side pots, each correctly split', async () => {
    // Stacks: 10 / 25 / 60 / 100. Everyone shoves.
    // Contributions: P0=10, P1=25, P2=60, P3=100.
    // Pots (capped iteratively):
    //   Pot 0 (cap 10): 10*4 = 40, eligible all 4.
    //   Pot 1 (cap 25): 15*3 = 45, eligible P1, P2, P3.
    //   Pot 2 (cap 60): 35*2 = 70, eligible P2, P3.
    //   Pot 3 (cap 100): 40*1 = 40, eligible P3 only (uncontested → returned to P3).
    //   Total: 40+45+70+40 = 195. Sum of contributions: 10+25+60+100 = 195. ✓
    setForcedDeck(
      buildPartialDeck([
        // Hole cards designed so different players win different pots:
        //   P0 has the worst hand (junk).
        //   P1 has middle-rank hand.
        //   P2 has second-best.
        //   P3 has the best (pocket aces).
        // But we want to test side-pot ELIGIBILITY, so let's pick cards
        // such that P1 wins main pot (with everyone eligible, P1's cards
        // make a hand only THEY have access to), etc. That's hard
        // without contrived holdings.
        //
        // Simpler: give them all junk and let board cards play (straight
        // flush on board), so all 4 split each pot they're eligible for.
        '2c', '3c',          // P0=BTN
        '4c', '5c',          // P1=SB
        '6c', '7c',          // P2=BB
        '8c', '9c',          // P3=UTG
        '5s', '6s', '7s',    // flop (3 spades — straight flush draw)
        '8s',                // turn (4 spades)
        '9s',                // river (5-card straight flush 5-9s on board)
      ])
    );
    const r = await runScripted({
      name: 'FH-05_4way_allin_3_side_pots',
      players: 4,
      stacks: [10, 25, 60, 100],
      hands: [
        {
          // Preflop order: UTG, BTN, SB, BB.
          preflop: [
            { actor: 'UTG', action: 'all-in' }, // 100 (UTG=P3=seat 3)
            { actor: 'BTN', action: 'all-in' }, // 10 (BTN=P0=seat 0)
            { actor: 'SB',  action: 'all-in' }, // 25 (SB=P1=seat 1)
            { actor: 'BB',  action: 'all-in' }, // 60 (BB=P2=seat 2)
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // All on board straight flush 5-9 spades → split each pot.
        // Pot 0 (40, all 4 eligible): 10 each.
        // Pot 1 (45, P1+P2+P3 eligible): 15 each.
        // Pot 2 (70, P2+P3 eligible): 35 each.
        // Pot 3 (40, P3 only): 40.
        // Final stacks (everyone busted from preflop, so all 0 mid-hand,
        // plus winnings):
        //   P0=BTN=seat 0: 10 (pot 0 share)
        //   P1=SB=seat 1: 10 + 15 = 25
        //   P2=BB=seat 2: 10 + 15 + 35 = 60
        //   P3=UTG=seat 3: 10 + 15 + 35 + 40 = 100
        // Net change: 0 / 0 / 0 / 0. Each gets back their original.
        finalStacks: [10, 25, 60, 100],
      },
    });
    assertScriptedOk('FH-05', r);
  });

  it('FH-06: 4-handed across 4 hands — every seat dealer once, money conserved', async () => {
    const r = await runScripted({
      name: 'FH-06_dealer_full_rotation',
      players: 4,
      stacks: [200, 200, 200, 200],
      hands: [
        // Hand 1 (dealer=0): walk
        { preflop: [
          { actor: 'UTG', action: 'fold' },
          { actor: 'BTN', action: 'fold' },
          { actor: 'SB',  action: 'fold' },
        ] },
        // Hand 2 (dealer=1): walk
        { preflop: [
          { actor: 'UTG', action: 'fold' },
          { actor: 'BTN', action: 'fold' },
          { actor: 'SB',  action: 'fold' },
        ] },
        // Hand 3 (dealer=2): walk
        { preflop: [
          { actor: 'UTG', action: 'fold' },
          { actor: 'BTN', action: 'fold' },
          { actor: 'SB',  action: 'fold' },
        ] },
        // Hand 4 (dealer=3): walk
        { preflop: [
          { actor: 'UTG', action: 'fold' },
          { actor: 'BTN', action: 'fold' },
          { actor: 'SB',  action: 'fold' },
        ] },
      ],
      expect: {
        handsCompleted: 4,
        // Each seat is BB exactly once (gains 0.5 from SB's blind),
        // SB once (loses 0.5 to BB), BTN once (no movement), UTG once
        // (no movement, just folds). Net 0 for everyone after 4 hands.
        finalStacks: [200, 200, 200, 200],
      },
    });
    assertScriptedOk('FH-06', r);
  });
});
