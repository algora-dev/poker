/**
 * Layer C — combinatorial generator runner.
 *
 * Enumerates legal action templates × stack profiles × player counts
 * and asserts every generated scenario passes invariants. No specific
 * chip outcome is asserted (that's the hand-crafted scenarios' job);
 * the generator covers BREADTH while the hand-crafted suite covers DEPTH.
 *
 * Pass criterion: 100% of generated scenarios must succeed. Any failure
 * is a real bug in either the engine or the generator's legality logic.
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

import { runGenerator, generateScenarios } from './generator';
import { clearForcedDeck } from './forcedDeck';

describe('Layer C — combinatorial generator', () => {
  beforeEach(() => {
    clearForcedDeck();
  });

  it('generates a non-empty curated set of scenarios', () => {
    const list = generateScenarios();
    // At least: 6 player counts × 6 profiles × ~3 templates per profile =
    // a few dozen. We expect at least 50.
    expect(list.length).toBeGreaterThan(50);
  });

  it('every generated scenario passes invariants and chip conservation', async () => {
    const report = await runGenerator();
    if (report.failed > 0) {
      const summary = report.failures
        .map((f) => `[${f.label}] ${f.summary}`)
        .join('\n');
      throw new Error(
        `Generator: ${report.passed}/${report.totalScenarios} passed; ${report.failed} failed:\n${summary}`
      );
    }
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.totalScenarios);
    // Sanity: generator should have exercised at least 50 scenarios.
    expect(report.totalScenarios).toBeGreaterThan(50);
  }, 60_000);
});
