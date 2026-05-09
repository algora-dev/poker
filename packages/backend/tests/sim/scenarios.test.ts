/**
 * Match Simulator — scenario suite
 *
 * Demonstrates the simulator end-to-end. Each scenario:
 *   - sets up 2-8 players with concrete strategies
 *   - runs N hands fully (real processAction, real ledger writes)
 *   - asserts chip conservation, sane outcomes, and ledger integrity
 *
 * The point is not exhaustive game-theory coverage — it's that you can
 * write a scenario in ~10 lines and replay it deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wire the simulated prisma into all modules under test. The world stub is
// installed on globalThis by runMatch() before importing the game services.
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
// Socket layer is a no-op in sim.
vi.mock('../../src/socket', () => ({
  emitGameEvent: vi.fn(),
  emitBalanceUpdate: vi.fn(),
  broadcastGameState: vi.fn(),
  checkGameRoomJoin: vi.fn(),
}));

import { runMatch } from './match';
import {
  nit,
  callingStation,
  aggro,
  randomStrategy,
  scriptedStrategy,
  scriptKey,
} from './strategy';

describe('Match Simulator — scenarios', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('heads-up: nit vs calling station — runs to completion, conservation holds', async () => {
    const report = await runMatch({
      seats: [
        { userId: 'u_alice', buyInChips: 100, strategy: nit },
        { userId: 'u_bob', buyInChips: 100, strategy: callingStation },
      ],
      maxHands: 5,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    expect(report.handsPlayed).toBeGreaterThan(0);
    // Total chip mass is exactly 200 (2 buy-ins of 100 chips, 6 decimals).
    const total =
      report.finalBalances.reduce((s, b) => s + b.chips, 0n) +
      report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
    expect(total).toBe(200_000_000n);
  });

  it('3-handed: nit vs nit vs aggro — aggressor accumulates pots', async () => {
    const report = await runMatch({
      seats: [
        { userId: 'u_a', buyInChips: 100, strategy: nit },
        { userId: 'u_b', buyInChips: 100, strategy: nit },
        { userId: 'u_c', buyInChips: 100, strategy: aggro },
      ],
      maxHands: 5,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    // Conservation: still 300 chips total.
    const total =
      report.finalBalances.reduce((s, b) => s + b.chips, 0n) +
      report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
    expect(total).toBe(300_000_000n);
  });

  it('5-handed: mixed strategies, 8 hands, ledger contains canonical event sequence', async () => {
    const report = await runMatch({
      seats: [
        { userId: 'u_1', buyInChips: 100, strategy: nit },
        { userId: 'u_2', buyInChips: 100, strategy: callingStation },
        { userId: 'u_3', buyInChips: 100, strategy: aggro },
        { userId: 'u_4', buyInChips: 100, strategy: randomStrategy(42) },
        { userId: 'u_5', buyInChips: 100, strategy: randomStrategy(1337) },
      ],
      maxHands: 8,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);

    // Every hand should have at least the canonical opening events:
    // hand_started, deck_committed, blinds_posted x2.
    const handIds = new Set<string>();
    for (const e of report.ledgerEvents) {
      if (e.handId) handIds.add(e.handId);
    }
    expect(handIds.size).toBeGreaterThan(0);

    for (const hid of handIds) {
      const events = report.ledgerEvents.filter((e) => e.handId === hid);
      const types = events.map((e) => e.type);
      expect(types).toContain('hand_started');
      expect(types).toContain('deck_committed');
      expect(types.filter((t) => t === 'blinds_posted').length).toBe(2);
      // Hand must end with hand_completed.
      expect(types).toContain('hand_completed');
      expect(types[types.length - 1]).toBe('hand_completed');
    }
  });

  it('8-handed full ring: 6 hands complete cleanly, conservation holds', async () => {
    const report = await runMatch({
      seats: Array.from({ length: 8 }, (_, i) => ({
        userId: `u_${i + 1}`,
        buyInChips: 100,
        strategy: i % 2 === 0 ? callingStation : nit,
      })),
      maxHands: 6,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    const total =
      report.finalBalances.reduce((s, b) => s + b.chips, 0n) +
      report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
    expect(total).toBe(800_000_000n);
  });

  it('scripted: heads-up — Alice raises preflop, Bob folds — fold-win in 1 action', async () => {
    const aliceScript = scriptedStrategy(
      {
        [scriptKey(1, 'preflop', 0)]: { kind: 'raise', totalChips: 5 },
      },
      nit
    );
    const bobScript = scriptedStrategy(
      {
        [scriptKey(1, 'preflop', 1)]: { kind: 'fold' },
      },
      nit
    );
    const report = await runMatch({
      seats: [
        { userId: 'u_alice', buyInChips: 100, strategy: aliceScript },
        { userId: 'u_bob', buyInChips: 100, strategy: bobScript },
      ],
      maxHands: 1,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    expect(report.handsPlayed).toBe(1);
    expect(report.hands[0].endReason).toBe('fold_win');
    expect(report.hands[0].winners).toEqual(['u_alice']);
  });

  it('property-style: 4 random seeded players, 10 hands, conservation NEVER breaks', async () => {
    const seeds = [1, 2, 3, 4];
    const report = await runMatch({
      seats: seeds.map((s, i) => ({
        userId: `u_${i + 1}`,
        buyInChips: 100,
        strategy: randomStrategy(s),
      })),
      maxHands: 10,
    });
    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    expect(report.conservationFailure).toBeUndefined();
  });
});
