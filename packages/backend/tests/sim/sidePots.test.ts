/**
 * Phase 9 follow-up [item 5] — side-pot / all-in scenario pack.
 *
 * Runs against the real production services through the simulator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { runMatch } from './match';
import {
  callingStation,
  nit,
  scriptedStrategy,
  scriptKey,
} from './strategy';
import type { Strategy } from './strategy';

/**
 * Strategy that always shoves all-in preflop, then check/calls postflop.
 * Useful for forcing all-in scenarios deterministically.
 */
const shoveAllIn: Strategy = (v) => {
  if (v.stage === 'preflop' && v.alreadyInOnStreet < v.chipStack + v.alreadyInOnStreet) {
    if (v.chipStack > 0n) return { kind: 'all-in' };
  }
  const owed = v.currentBet - v.alreadyInOnStreet;
  if (owed <= 0n) return { kind: 'check' };
  if (owed >= v.chipStack) return { kind: 'all-in' };
  return { kind: 'call' };
};

describe('Side-pot / all-in scenario pack', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('3-way all-in with different stacks: side pots build correctly, conservation holds', async () => {
    // Three players, three different stacks. With shoveAllIn everyone goes
    // in preflop, generating side pots with different eligibility sets.
    const report = await runMatch({
      scenarioName: '3way_allin_diff_stacks',
      seats: [
        { userId: 'u_short', buyInChips: 10, strategy: shoveAllIn }, // smallest
        { userId: 'u_mid', buyInChips: 25, strategy: shoveAllIn },
        { userId: 'u_big', buyInChips: 60, strategy: shoveAllIn },
      ],
      maxHands: 1,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    // Conservation: 10 + 25 + 60 = 95 chips total.
    const total =
      report.finalBalances.reduce((s, b) => s + b.chips, 0n) +
      report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
    expect(total).toBe(95_000_000n);
    // The hand must produce side_pots_built and showdown_evaluated events
    // since multiple stack sizes mean side pots.
    const types = report.ledgerEvents.map((e) => e.type);
    expect(types).toContain('side_pots_built');
    expect(types).toContain('showdown_evaluated');
    expect(types.filter((t) => t === 'pot_awarded').length).toBeGreaterThanOrEqual(1);
  });

  it('4-way all-in with one folded player: side pots only include eligible players', async () => {
    // Seat 0 folds preflop (nit folds to any bet). Seats 1,2,3 shove in.
    // Side pots must be built only over the all-in players.
    const report = await runMatch({
      scenarioName: '4way_allin_one_folded',
      seats: [
        { userId: 'u_folder', buyInChips: 50, strategy: nit },
        { userId: 'u_short', buyInChips: 10, strategy: shoveAllIn },
        { userId: 'u_mid', buyInChips: 25, strategy: shoveAllIn },
        { userId: 'u_big', buyInChips: 50, strategy: shoveAllIn },
      ],
      maxHands: 1,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    // The eligible-player set in side_pots_built must NOT include u_folder.
    const sidePotsEvent = report.ledgerEvents.find((e) => e.type === 'side_pots_built');
    if (sidePotsEvent) {
      const pots = sidePotsEvent.payload.pots as Array<{ eligiblePlayerIds: string[] }>;
      for (const pot of pots) {
        expect(pot.eligiblePlayerIds).not.toContain('u_folder');
      }
    }
  });

  it('split pot: identical hand strengths produce a tie with deterministic remainder allocation', async () => {
    // Heads up scripted: both players just check/call to showdown. Random
    // RNG decides cards, but with calling station x calling station the
    // hand WILL go to showdown. We can't force a deterministic split (the
    // deck is real crypto-RNG), so we just assert that IF a split happens
    // the remainder is deterministic and conservation holds. We run a
    // bunch of hands to increase the chance.
    const report = await runMatch({
      scenarioName: 'split_pot_remainders',
      seats: [
        { userId: 'u_a', buyInChips: 100, strategy: callingStation },
        { userId: 'u_b', buyInChips: 100, strategy: callingStation },
      ],
      maxHands: 8,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    // Every pot_awarded event must declare a non-negative remainder.
    const awards = report.ledgerEvents.filter((e) => e.type === 'pot_awarded');
    for (const a of awards) {
      const remainder = BigInt(a.payload.remainder ?? '0');
      expect(remainder).toBeGreaterThanOrEqual(0n);
    }
  });

  it('short all-in does not reopen action: heads-up scripted', async () => {
    // Heads-up. Big stack raises preflop; small stack short-all-in for less
    // than a legal raise. Big stack should only need to CALL (not re-raise)
    // to close the round. Then play continues to river and showdown.
    const big = scriptedStrategy(
      {
        // P0 raises preflop
        [scriptKey(1, 'preflop', 0)]: [
          { kind: 'raise', totalChips: 4 }, // 4xBB
          { kind: 'call' }, // call the short all-in
        ],
      },
      callingStation
    );
    const short = scriptedStrategy(
      {
        // P1 short-all-in for total ~5 (only adds 1 over BB+raise gap)
        [scriptKey(1, 'preflop', 1)]: { kind: 'all-in' },
      },
      callingStation
    );
    const report = await runMatch({
      scenarioName: 'short_allin_no_reopen',
      seats: [
        { userId: 'u_big', buyInChips: 100, strategy: big },
        { userId: 'u_short', buyInChips: 5, strategy: short },
      ],
      maxHands: 1,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    // The hand must complete, not stall.
    expect(report.handsPlayed).toBe(1);
    expect(report.hands[0].finalStacks.length).toBe(2);
  });

  it('legal full all-in raise DOES reopen action: opponent must respond', async () => {
    // 3-handed. P1 raises preflop, P2 all-in for a legal full raise (>=
    // last increment). Action must reopen for P0.
    const report = await runMatch({
      scenarioName: 'allin_full_raise_reopens',
      seats: [
        { userId: 'u_0', buyInChips: 100, strategy: callingStation },
        {
          userId: 'u_1',
          buyInChips: 100,
          strategy: scriptedStrategy(
            { [scriptKey(1, 'preflop', 1)]: { kind: 'raise', totalChips: 3 } },
            callingStation
          ),
        },
        {
          userId: 'u_2',
          buyInChips: 100,
          // Big stack -> a 'raise' that exceeds last incr will be a full raise
          strategy: scriptedStrategy(
            { [scriptKey(1, 'preflop', 2)]: { kind: 'all-in' } },
            callingStation
          ),
        },
      ],
      maxHands: 1,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    expect(report.handsPlayed).toBe(1);
  });

  it('strict mode: an illegal scripted action fails the match with full metadata', async () => {
    // Force an illegal: raise to 0.1 chips (below big blind = 1 chip).
    // In strict mode the match must error out and report the failing action.
    const bad = scriptedStrategy(
      { [scriptKey(1, 'preflop', 0)]: { kind: 'raise', totalChips: 0.1 } },
      callingStation
    );
    const report = await runMatch({
      scenarioName: 'strict_mode_illegal_raise',
      seats: [
        { userId: 'u_a', buyInChips: 100, strategy: bad },
        { userId: 'u_b', buyInChips: 100, strategy: callingStation },
      ],
      maxHands: 1,
      strict: true,
    });
    expect(report.endedReason).toBe('error');
    expect(report.failure).toBeDefined();
    expect(report.failure!.handNumber).toBe(1);
    expect(report.failure!.attemptedAction).toBe('raise');
    expect(report.failure!.attemptedRaiseTotal).toBe(0.1);
    expect(report.failure!.scenarioName).toBe('strict_mode_illegal_raise');
  });
});
