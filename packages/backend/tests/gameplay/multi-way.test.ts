/**
 * Layer B — multi-way (5/6/7/8-handed) gameplay scenarios.
 *
 * Targets:
 *   - 5-handed cold-call test (raise + multi-way calls)
 *   - 6-handed multi-way all-in producing 4 side pots
 *   - 7-handed early position raise + late position 3-bet
 *   - 8-handed BB option after walking limpers (full table)
 *   - Board plays / kicker / wheel straight at 6-max
 *   - Long position rotation across 16 hands (stability)
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

describe('Layer B — multi-way scenarios (5–8 handed)', () => {
  beforeEach(() => {
    clearForcedDeck();
  });

  it('MW-01: 5-handed cold-call — UTG raises, two cold callers, BTN folds, blinds defend', async () => {
    setForcedDeck(
      buildPartialDeck([
        // 5 seats. Deal order: seat 0 (BTN), 1 (SB), 2 (BB), 3 (UTG), 4 (UTG+1 / CO)
        '2c', '3c',          // BTN
        '4c', '5c',          // SB
        '6c', '7c',          // BB
        '8c', '9c',          // UTG
        'Tc', 'Jc',          // UTG+1 (CO in 5max — but our resolver: at n=5 with no MP+1, position label collisions: per resolver, n=5 means HJ=undefined, CO=seatsInOrder[n-1]=seat-after-BTN-back, UTG=3, UTG+1=4. We use seat indices for clarity below.)
        // Board: 5d 6h 7s 8h 2d (no flush, no straight that everyone hits)
        '5d', '6h', '7s',
        '8h',
        '2d',
      ])
    );
    const r = await runScripted({
      name: 'MW-01_5h_cold_call',
      players: 5,
      stacks: [200, 200, 200, 200, 200],
      hands: [
        {
          // Preflop order in 5-handed: UTG (seat 3), UTG+1 (seat 4), BTN (seat 0), SB (seat 1), BB (seat 2).
          // (UTG+1 is the 5th seat, sometimes called CO at 5-max.)
          preflop: [
            { seat: 3, action: 'raise', amount: 4 },  // UTG opens to 4
            { seat: 4, action: 'call' },              // UTG+1 cold-calls
            { seat: 0, action: 'fold' },              // BTN folds
            { seat: 1, action: 'fold' },              // SB folds
            { seat: 2, action: 'call' },              // BB defends — calls 4 (3 more on top of BB)
          ],
          // Postflop order: SB (folded skip), BB, UTG, UTG+1.
          flop: [
            { seat: 2, action: 'check' },
            { seat: 3, action: 'check' },
            { seat: 4, action: 'check' },
          ],
          turn: [
            { seat: 2, action: 'check' },
            { seat: 3, action: 'check' },
            { seat: 4, action: 'check' },
          ],
          river: [
            { seat: 2, action: 'check' },
            { seat: 3, action: 'check' },
            { seat: 4, action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot = 4 + 4 + 4 + 0.5 (folded SB) = 12.5 chips.
        // Hands at showdown:
        //   BB (seat 2): 6c 7c + board 5d 6h 7s 8h 2d → straight 5-6-7-8 (need 4 or 9). No.
        //     Two pair: 7s+7c, 6h+6c → two pair 7s and 6s with 8 kicker.
        //   UTG (seat 3): 8c 9c + board → straight 5-6-7-8-9? No 9 on board. Has 9c hole + 5-6-7-8 board → straight 5-9.
        //   UTG+1 (seat 4): Tc Jc + board → no straight (need 9), pair? No pairs. Just T-J high.
        // UTG wins with straight 5-9.
        // BB: 200 - 4 = 196.
        // UTG: 200 - 4 + 12.5 = 208.5.
        // UTG+1: 200 - 4 = 196.
        // BTN: 200 (folded preflop, no contribution).
        // SB: 200 - 0.5 = 199.5.
        finalStacks: [200, 199.5, 196, 208.5, 196],
      },
    });
    assertScriptedOk('MW-01', r);
  });

  it('MW-02: 6-handed multi-way all-in produces 4 side pots all correctly split', async () => {
    // Stacks: 5/15/30/50/80/120. Everyone shoves preflop. Forced board
    // gives a straight flush so all 6 split each pot they're eligible for.
    setForcedDeck(
      buildPartialDeck([
        '2c', '3c',          // seat 0 (BTN, stack 5)
        '4c', '5c',          // seat 1 (SB, stack 15)
        '6c', '7c',          // seat 2 (BB, stack 30)
        '8c', '9c',          // seat 3 (UTG, stack 50)
        'Tc', 'Jc',          // seat 4 (HJ/UTG+1, stack 80)
        'Qc', 'Kc',          // seat 5 (CO, stack 120)
        '5s', '6s', '7s',    // flop
        '8s',                // turn
        '9s',                // river: 5-9 straight flush of spades on board
      ])
    );
    const r = await runScripted({
      name: 'MW-02_6h_4_side_pots',
      players: 6,
      stacks: [5, 15, 30, 50, 80, 120],
      hands: [
        {
          // Preflop order in 6-handed: UTG, HJ/UTG+1, CO, BTN, SB, BB.
          // (Engine: nextActive(BB)=UTG=seat 3.)
          preflop: [
            { seat: 3, action: 'all-in' }, // UTG (50)
            { seat: 4, action: 'all-in' }, // HJ (80)
            { seat: 5, action: 'all-in' }, // CO (120)
            { seat: 0, action: 'all-in' }, // BTN (5)
            { seat: 1, action: 'all-in' }, // SB (15)
            { seat: 2, action: 'all-in' }, // BB (30)
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Contributions: 5/15/30/50/80/120. Total 300.
        // Pots iteratively:
        //   Pot 0 (cap 5):  5*6 = 30.   Eligible: all 6.
        //   Pot 1 (cap 15): 10*5 = 50.  Eligible: seats 1,2,3,4,5.
        //   Pot 2 (cap 30): 15*4 = 60.  Eligible: seats 2,3,4,5.
        //   Pot 3 (cap 50): 20*3 = 60.  Eligible: seats 3,4,5.
        //   Pot 4 (cap 80): 30*2 = 60.  Eligible: seats 4,5.
        //   Pot 5 (cap 120): 40*1 = 40. Eligible: seat 5 only (uncontested → returned).
        //   Sum: 30+50+60+60+60+40 = 300 ✓.
        // Board makes 5-9 straight flush spades; all play it.
        // Pot 0: 30/6 = 5 each.
        // Pot 1: 50/5 = 10 each (seats 1-5).
        // Pot 2: 60/4 = 15 each (seats 2-5).
        // Pot 3: 60/3 = 20 each (seats 3-5).
        // Pot 4: 60/2 = 30 each (seats 4-5).
        // Pot 5: 40 (seat 5).
        // Per-seat winnings:
        //   0: 5
        //   1: 5+10 = 15
        //   2: 5+10+15 = 30
        //   3: 5+10+15+20 = 50
        //   4: 5+10+15+20+30 = 80
        //   5: 5+10+15+20+30+40 = 120
        // Each gets back their original stack. Net: 0 across the board.
        finalStacks: [5, 15, 30, 50, 80, 120],
      },
    });
    assertScriptedOk('MW-02', r);
  });

  it('MW-03: 7-handed UTG raise, late-position 3-bet, blinds fold, original raiser calls', async () => {
    setForcedDeck(
      buildPartialDeck([
        // Seats 0-6. Deal order: seat 0 (BTN), 1 (SB), 2 (BB), 3 (UTG), 4, 5, 6 (CO).
        '2c', '3c',          // BTN
        '4c', '5c',          // SB
        '6c', '7c',          // BB
        'As', 'Ad',          // UTG: pocket aces
        '8c', '9c',          // UTG+1
        'Tc', 'Jc',          // HJ
        'Kd', 'Qd',          // CO
        // Board: pocket aces will win (no flush, no straight)
        '5d', '6h', '7s',
        '8h',
        '2h',
      ])
    );
    const r = await runScripted({
      name: 'MW-03_7h_3bet_call',
      players: 7,
      stacks: [200, 200, 200, 200, 200, 200, 200],
      hands: [
        {
          // 7-handed preflop order: UTG (3), UTG+1 (4), HJ (5), CO (6), BTN (0), SB (1), BB (2).
          preflop: [
            { seat: 3, action: 'raise', amount: 4 },   // UTG opens
            { seat: 4, action: 'fold' },               // UTG+1 folds
            { seat: 5, action: 'fold' },               // HJ folds
            { seat: 6, action: 'raise', amount: 14 },  // CO 3-bets to 14 (increment 10)
            { seat: 0, action: 'fold' },               // BTN folds
            { seat: 1, action: 'fold' },               // SB folds
            { seat: 2, action: 'fold' },               // BB folds
            { seat: 3, action: 'call' },               // UTG calls 14
          ],
          flop: [
            { seat: 3, action: 'check' },
            { seat: 6, action: 'check' },
          ],
          turn: [
            { seat: 3, action: 'check' },
            { seat: 6, action: 'check' },
          ],
          river: [
            { seat: 3, action: 'check' },
            { seat: 6, action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot: 14 + 14 + 0.5 (SB) + 1 (BB) = 29.5.
        // Wait. Wait: seat 5 already had 0 contributed (fold), seat 4 same.
        // SB seat 1: 0.5 (folded, contribution stays in pot).
        // BB seat 2: 1 (folded, contribution stays in pot).
        // UTG seat 3: 14.
        // CO seat 6: 14.
        // Total: 0.5 + 1 + 14 + 14 = 29.5 chips.
        //
        // Hands at showdown:
        //   UTG seat 3: As Ad + board 5d 6h 7s 8h 2c → pair of aces, 8-7-6 kickers.
        //   CO seat 6: Kd Qd + board → K-Q high. No pair.
        // UTG wins entire pot.
        // UTG: 200 - 14 + 29.5 = 215.5.
        // CO: 200 - 14 = 186.
        // SB: 200 - 0.5 = 199.5.
        // BB: 200 - 1 = 199.
        // Others: 200.
        finalStacks: [200, 199.5, 199, 215.5, 200, 200, 186],
      },
    });
    assertScriptedOk('MW-03', r);
  });

  it('MW-04: 8-handed full table, BB option after limps, all check down to 8-way split', async () => {
    setForcedDeck(
      buildPartialDeck([
        '2c', '3c',          // seat 0 (BTN)
        '4c', '5c',          // seat 1 (SB)
        '6c', '7c',          // seat 2 (BB)
        '8c', '9c',          // seat 3 (UTG)
        'Tc', 'Jc',          // seat 4 (UTG+1)
        '6d', '7d',          // seat 5 (no K/Q so they play board only)
        '2d', '3d',          // seat 6
        '4d', '5d',          // seat 7
        // Board: KKK QQ → all 8 play KKKQQ off the board, 8-way split.
        'Ks', 'Kh', 'Kd',
        'Qs',
        'Qd',
      ])
    );
    const r = await runScripted({
      name: 'MW-04_8h_bb_option_check_down',
      players: 8,
      stacks: [200, 200, 200, 200, 200, 200, 200, 200],
      hands: [
        {
          // Preflop order: UTG (3), UTG+1 (4), MP (5), HJ (6), CO (7), BTN (0), SB (1), BB (2).
          preflop: [
            { seat: 3, action: 'call' },   // UTG limp
            { seat: 4, action: 'call' },   // UTG+1 limp
            { seat: 5, action: 'call' },   // MP limp
            { seat: 6, action: 'call' },   // HJ limp
            { seat: 7, action: 'call' },   // CO limp
            { seat: 0, action: 'call' },   // BTN limp
            { seat: 1, action: 'call' },   // SB completes (already 0.5 in)
            { seat: 2, action: 'check' },  // BB option exercised
          ],
          // Postflop order: SB, BB, UTG, UTG+1, MP, HJ, CO, BTN.
          flop: [
            { seat: 1, action: 'check' },
            { seat: 2, action: 'check' },
            { seat: 3, action: 'check' },
            { seat: 4, action: 'check' },
            { seat: 5, action: 'check' },
            { seat: 6, action: 'check' },
            { seat: 7, action: 'check' },
            { seat: 0, action: 'check' },
          ],
          turn: [
            { seat: 1, action: 'check' },
            { seat: 2, action: 'check' },
            { seat: 3, action: 'check' },
            { seat: 4, action: 'check' },
            { seat: 5, action: 'check' },
            { seat: 6, action: 'check' },
            { seat: 7, action: 'check' },
            { seat: 0, action: 'check' },
          ],
          river: [
            { seat: 1, action: 'check' },
            { seat: 2, action: 'check' },
            { seat: 3, action: 'check' },
            { seat: 4, action: 'check' },
            { seat: 5, action: 'check' },
            { seat: 6, action: 'check' },
            { seat: 7, action: 'check' },
            { seat: 0, action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot = 8 chips. Board KKK QQ → all 8 play KKKQQ.
        // 8 / 8 = 1 each, no remainder. Net 0/0/0/0/0/0/0/0.
        finalStacks: [200, 200, 200, 200, 200, 200, 200, 200],
      },
    });
    assertScriptedOk('MW-04', r);
  });

  it('MW-05: wheel straight (A-2-3-4-5) + kicker tiebreak', async () => {
    // 6-handed. Hero (UTG, seat 3) has A-2; villain (BTN, seat 0) has K-2.
    // Board: 3 4 5 K Q. Hero plays A-2-3-4-5 (wheel). Villain plays
    // pair of kings + best kicker. Hero wins.
    setForcedDeck(
      buildPartialDeck([
        'Ks', '2s',          // BTN (seat 0): K2 offsuit-ish (Ks 2s — has flush draw!)
        '7c', '8c',          // SB (seat 1)
        '9c', 'Tc',          // BB (seat 2)
        'As', '2c',          // UTG (seat 3): A-2 — for wheel
        '6c', '7d',          // UTG+1 (seat 4)
        'Jc', 'Qc',          // CO (seat 5)
        // Board:
        '3d', '4h', '5d',    // flop: gives wheel possibility
        'Kc',                // turn: gives BTN pair of kings
        'Qh',                // river: just a queen
      ])
    );
    const r = await runScripted({
      name: 'MW-05_wheel_kicker',
      players: 6,
      stacks: [200, 200, 200, 200, 200, 200],
      hands: [
        {
          // Folds around to UTG who opens; only BTN calls.
          preflop: [
            { seat: 3, action: 'raise', amount: 4 },   // UTG opens
            { seat: 4, action: 'fold' },
            { seat: 5, action: 'fold' },
            { seat: 0, action: 'call' },               // BTN calls
            { seat: 1, action: 'fold' },
            { seat: 2, action: 'fold' },
          ],
          flop: [
            { seat: 3, action: 'check' },
            { seat: 0, action: 'check' },
          ],
          turn: [
            { seat: 3, action: 'check' },
            { seat: 0, action: 'check' },
          ],
          river: [
            { seat: 3, action: 'check' },
            { seat: 0, action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot = 4 + 4 + 0.5 + 1 = 9.5.
        // BTN seat 0: Ks 2s + board 3d 4h 5d Kc Qh.
        //   Best 5: K K (one from hole, one from board) + Q + 5 + 4 = pair of kings.
        // UTG seat 3: As 2c + board 3d 4h 5d Kc Qh.
        //   Best 5: A-2-3-4-5 = wheel straight.
        // Wheel straight beats pair of kings. UTG wins 9.5.
        // UTG: 200 - 4 + 9.5 = 205.5.
        // BTN: 200 - 4 = 196.
        // SB: 200 - 0.5 = 199.5.
        // BB: 200 - 1 = 199.
        // Others: 200.
        finalStacks: [196, 199.5, 199, 205.5, 200, 200],
      },
    });
    assertScriptedOk('MW-05', r);
  });

  it('MW-06: 6-handed long rotation (16 hands of fold-around) — game stays alive, money conserved', async () => {
    const fold = { action: 'fold' as const };
    const walks = Array.from({ length: 16 }, () => ({
      preflop: [
        { seat: 3, ...fold },
        { seat: 4, ...fold },
        { seat: 5, ...fold },
        { seat: 0, ...fold },
        { seat: 1, ...fold },
        // BB takes blinds uncontested.
      ],
    }));
    const r = await runScripted({
      name: 'MW-06_6h_16hand_rotation',
      players: 6,
      stacks: [200, 200, 200, 200, 200, 200],
      hands: walks,
      expect: {
        handsCompleted: 16,
        // Each seat should be BB exactly 16/6 ≈ 2.67 times. Net is NOT
        // exactly 0 unless 16 is a multiple of 6. So we don't pin per-seat
        // stacks. We just assert the suite ran 16 hands AND total chips
        // conserved (the runScripted invariant suite does this every step).
        // Just ensure no game-end.
      },
    });
    assertScriptedOk('MW-06', r);
    expect(r.report.handsPlayed).toBe(16);
    // Total chips conservation: 6 × 200 = 1200.
    const totalStack = r.report.finalStacks.reduce((s, p) => s + Number(p.chipStack), 0);
    const totalBalance = r.report.finalBalances.reduce((s, p) => s + Number(p.chips), 0);
    const totalChips = (totalStack + totalBalance) / 1_000_000;
    expect(totalChips).toBe(1200);
  });
});
