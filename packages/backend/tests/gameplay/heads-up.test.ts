/**
 * Layer B — heads-up gameplay scenarios.
 *
 * Per Gerald's audit-20 ask + my own list. Targets every heads-up
 * decision point: SB-acts-first preflop, BB option, walks, all-in
 * confrontations, river check-raise, board-plays edges.
 *
 * Forced decks are used wherever the assertion depends on cards
 * (e.g. board plays, kickers). Where the assertion is purely
 * money-flow (folds, walks), the deck is left to the engine's RNG.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScripted } from './dsl';
import { setForcedDeck, clearForcedDeck, buildPartialDeck } from './forcedDeck';

// ---- Module mocks (same pattern as scenarios.test.ts) ----
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

// Mock the deck shuffle: when a forced deck is set, return it; otherwise
// fall back to the real crypto-secure shuffle.
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

// Helper to fail a scripted run with a maximally-useful diagnostic.
function assertScriptedOk(name: string, r: Awaited<ReturnType<typeof runScripted>>) {
  if (r.ok) return;
  const lines: string[] = [
    `Scripted run [${name}] FAILED: ${r.failureSummary ?? 'see violations'}`,
    `Ended reason: ${r.report.endedReason}`,
    ...(r.report.error ? [`Error: ${r.report.error}`] : []),
    ...(r.report.failure
      ? [`Failure: ${JSON.stringify(r.report.failure, null, 2)}`]
      : []),
    ...(r.invariantViolations.length
      ? [`Invariants: ${r.invariantViolations.map((v) => `[${v.id}] ${v.message}`).join(' | ')}`]
      : []),
    ...(r.legalityFailures.length
      ? [`Legality: ${r.legalityFailures.map((f) => `hand ${f.handNumber} ${f.stage} seat${f.seat} intended=${f.intended.kind}${f.intended.raiseTotal != null ? '@' + f.intended.raiseTotal : ''}; ${f.reason}; legal=[${f.legalKinds.join(',')}]`).join(' | ')}`]
      : []),
    `FinalStacks: ${JSON.stringify(r.report.finalStacks.map((s) => ({ uid: s.userId, chips: Number(s.chipStack) / 1_000_000 })))}`,
    `Hands: ${r.report.hands.length}`,
  ];
  throw new Error(lines.join('\n'));
}

describe('Layer B — heads-up scenarios', () => {
  beforeEach(() => {
    // Do NOT vi.resetModules() here — the deck mock factory captures a
    // module instance of ./forcedDeck once, and resetting modules between
    // scenarios would create a NEW instance whose _active is null,
    // silently bypassing the forced deck. Found 2026-05-09 debugging HU-02.
    clearForcedDeck();
  });

  it('HU-01: SB folds preflop (walk), BB collects blinds', async () => {
    const r = await runScripted({
      name: 'HU-01_sb_walk',
      players: 2,
      stacks: [200, 200],
      hands: [
        {
          preflop: [{ actor: 'SB', action: 'fold' }],
        },
      ],
      expect: {
        handsCompleted: 1,
        finalStacks: [199.5, 200.5],
      },
    });
    assertScriptedOk('HU-01', r);
  });

  it('HU-02: SB calls, BB checks option, both check down to showdown', async () => {
    // Engine deal order (no burns):
    //   cards 0-1: seat 0 hole, cards 2-3: seat 1 hole,
    //   cards 4-6: flop, card 7: turn, card 8: river.
    setForcedDeck(
      buildPartialDeck([
        '2c', '3c',          // seat 0 (SB) hole: 2c 3c
        '7d', '8d',          // seat 1 (BB) hole: 7d 8d
        'Ks', 'Kh', 'Kd',    // flop KKK
        'Qs',                // turn Q
        'Qd',                // river Q
      ])
    );
    const r = await runScripted({
      name: 'HU-02_check_down',
      players: 2,
      stacks: [200, 200],
      hands: [
        {
          // Both have 2 chips committed (BB + SB→call=BB).
          preflop: [
            { actor: 'SB', action: 'call' }, // SB calls 0.5 more, total 1
            { actor: 'BB', action: 'check' }, // BB option exercised
          ],
          flop: [
            { actor: 'BB', action: 'check' },
            { actor: 'SB', action: 'check' },
          ],
          turn: [
            { actor: 'BB', action: 'check' },
            { actor: 'SB', action: 'check' },
          ],
          river: [
            { actor: 'BB', action: 'check' },
            { actor: 'SB', action: 'check' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Board KKK QQ. SB hole 2c-3c, BB hole 7d-8d.
        // Both play KKKQQ off the board. Split pot of 2 chips.
        // Each gets 1 chip back: 199 + 1 = 200, 199 + 1 = 200. Net: 0/0.
        finalStacks: [200, 200],
      },
    });
    assertScriptedOk('HU-02', r);
  });

  it('HU-03: SB raises 3x, BB calls, see flop, BB shoves, SB folds', async () => {
    const r = await runScripted({
      name: 'HU-03_3bet_call_shove_fold',
      players: 2,
      stacks: [200, 200],
      hands: [
        {
          preflop: [
            { actor: 'SB', action: 'raise', amount: 3 }, // raise to 3 total
            { actor: 'BB', action: 'call' }, // call 2 more
          ],
          flop: [
            { actor: 'BB', action: 'all-in' }, // shove 197 (their stack)
            { actor: 'SB', action: 'fold' }, // give up 3 + their share of pot
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Pot pre-fold: 3 + 3 + 197 = 203. SB folds, BB takes pot.
        // SB lost 3 (preflop+flop committed). BB net +3.
        finalStacks: [197, 203],
      },
    });
    assertScriptedOk('HU-03', r);
  });

  it('HU-04: both shove preflop, deck forces split pot', async () => {
    setForcedDeck(
      buildPartialDeck([
        'As', 'Kc',          // seat 0 hole: As Kc
        'Ad', 'Kh',          // seat 1 hole: Ad Kh
        '5h', '6d', '7s',    // flop
        '8s',                // turn
        '9s',                // river
      ])
    );
    const r = await runScripted({
      name: 'HU-04_split_pot',
      players: 2,
      stacks: [100, 100],
      hands: [
        {
          preflop: [
            { actor: 'SB', action: 'all-in' }, // shove 99.5 more (total 100)
            { actor: 'BB', action: 'call' },   // call all-in
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // Hands: SB AsKc, BB AdKh. Board 5h 6d 7s 8s 9s.
        // Both make a straight 5-9 (board plays). Split pot.
        // Each gets 100 back.
        finalStacks: [100, 100],
      },
    });
    assertScriptedOk('HU-04', r);
  });

  it('HU-05: SB raises, BB 3-bets, SB 4-bet shoves, BB calls, kicker tiebreak', async () => {
    setForcedDeck(
      buildPartialDeck([
        'Ac', 'Kd',          // seat 0 (SB) hole: Ac Kd
        'Ah', 'Qs',          // seat 1 (BB) hole: Ah Qs
        '5d', '6h', '7s',    // flop
        '8h',                // turn
        '2d',                // river
      ])
    );
    const r = await runScripted({
      name: 'HU-05_4bet_shove',
      players: 2,
      stacks: [100, 100],
      hands: [
        {
          preflop: [
            { actor: 'SB', action: 'raise', amount: 3 },
            { actor: 'BB', action: 'raise', amount: 9 },     // 3-bet to 9
            { actor: 'SB', action: 'all-in' },               // shove 100 total
            { actor: 'BB', action: 'call' },
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // SB AcKd, BB AhQs, board 5d 6h 7s 8h 2d — both have ace-high.
        // SB has K kicker, BB has Q kicker. SB wins entire 200 pot.
        // BB busts → game ends → closeGame refunds stacks to balances.
        // Final state: stacks both 0, balances [200, 0].
        finalStacks: [0, 0],
        finalBalances: [200, 0],
      },
    });
    assertScriptedOk('HU-05', r);
  });

  it('HU-06: river check-raise (BB checks, SB bets, BB raises, SB calls)', async () => {
    setForcedDeck(
      buildPartialDeck([
        'As', '2c',          // seat 0 (SB): As 2c (pair of aces possible)
        'Ks', '7s',          // seat 1 (BB): Ks 7s (flush draw if 3 spades on board)
        '4s', '6s', 'Td',    // flop: two spades
        'Jd',                // turn: blank
        '9s',                // river: third spade -> BB flush
      ])
    );

    const r = await runScripted({
      name: 'HU-06_river_checkraise',
      players: 2,
      stacks: [200, 200],
      hands: [
        {
          preflop: [
            { actor: 'SB', action: 'call' },
            { actor: 'BB', action: 'check' },
          ],
          flop: [
            { actor: 'BB', action: 'check' },
            { actor: 'SB', action: 'check' },
          ],
          turn: [
            { actor: 'BB', action: 'check' },
            { actor: 'SB', action: 'check' },
          ],
          river: [
            { actor: 'BB', action: 'check' },
            { actor: 'SB', action: 'raise', amount: 5 },  // bet 5
            { actor: 'BB', action: 'raise', amount: 20 }, // check-raise to 20
            { actor: 'SB', action: 'call' },              // call 15 more
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // SB committed 1 (preflop) + 5 (river bet) + 15 (call check-raise) = 21
        // BB committed 1 (preflop) + 20 (raise) = 21? No — BB's raise was TO 20, but they already had bet 5 from SB to call... wait, BB checked the river before SB bet, so BB had only 1 chip in (preflop). Then SB bets 5 (SB has 6 in). BB raises TO 20 (BB has 21 in: 1 preflop + 20 river? no the "to 20" total is just for this street). I think raise total in our DSL is street-cumulative, matching engine.
        // Actually in the engine, raise totalChips is the new currentBet for the street. So BB raises TO 20 = BB's stage contribution becomes 20 (was 0 on river since they checked). BB total committed: 1 preflop + 20 river = 21.
        // SB calls 20 - 5 already-on-street = 15 more. SB stage contribution: 20. Total committed: 1 + 20 = 21.
        // Pot = 42. BB wins (flush > pair). BB +21, SB -21.
        finalStacks: [179, 221],
      },
    });
    assertScriptedOk('HU-06', r);
  });
});
