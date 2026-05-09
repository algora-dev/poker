/**
 * Layer A smoke: minimum viable scripted hand.
 *
 * If THIS test passes, the DSL plumbing is alive: scripted strategies,
 * position resolution, per-step invariants, final expectations.
 *
 * Per Gerald's audit-20 verdict: prefer vi.mock for the deck. We don't
 * mock the deck in THIS test (the assertion doesn't depend on cards),
 * but the same vi.mock setup as `tests/sim/scenarios.test.ts` is required
 * because we call into the real game services.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// World wiring (same pattern as tests/sim/scenarios.test.ts).
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

import { runScripted } from './dsl';

describe('Layer A — DSL smoke', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('heads-up: SB folds preflop, BB takes blinds', async () => {
    const r = await runScripted({
      name: 'hu_sb_fold',
      players: 2,
      stacks: [200, 200],
      blinds: { sb: 0.5, bb: 1 },
      hands: [
        {
          // Heads-up: BTN === SB. Hand 1 dealer = seat 0.
          // Seat 0 is SB/BTN, posts 0.5. Seat 1 is BB, posts 1.
          // SB acts first preflop heads-up.
          preflop: [
            { actor: 'SB', action: 'fold' },
            // BB doesn't get to act; engine awards pot to BB.
          ],
        },
      ],
      expect: {
        handsCompleted: 1,
        // After SB folds: BB wins the 1.5 chip pot (their own BB + SB's blind).
        // Seat 0 (SB) lost 0.5, Seat 1 (BB) gained 0.5.
        // No mid-match deposits, so balances remain at 0 (chips are in stacks).
        finalStacks: [199.5, 200.5],
        finalBalances: [0, 0],
      },
    });

    if (!r.ok) {
      // Fail loudly with full diagnostic.
      const lines: string[] = [
        `Scripted run FAILED: ${r.failureSummary ?? 'see violations'}`,
        `Ended reason: ${r.report.endedReason}`,
        ...(r.report.error ? [`Error: ${r.report.error}`] : []),
        ...(r.report.failure
          ? [`Failure: ${JSON.stringify(r.report.failure, null, 2)}`]
          : []),
        ...(r.invariantViolations.length
          ? [`Invariants: ${r.invariantViolations.map((v) => `[${v.id}] ${v.message}`).join(' | ')}`]
          : []),
        `Normalized steps: ${JSON.stringify(r.normalizedSteps, null, 2)}`,
      ];
      throw new Error(lines.join('\n'));
    }

    expect(r.ok).toBe(true);
    expect(r.report.handsPlayed).toBe(1);
    expect(r.invariantViolations).toEqual([]);
  });
});
