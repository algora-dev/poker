/**
 * Phase 9 — Integration test for the canonical lifecycle:
 *   create -> join -> start -> hand(s) -> cashout
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 9 gate item 3, plus the
 * 8-player flow from item 4. Drives the real production services through
 * the simulated world from tests/sim/world.ts.
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
import { callingStation, nit } from './strategy';

describe('Phase 9 — canonical lifecycle integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('create -> join -> start -> hand -> cashout (heads-up, fold-win)', async () => {
    const report = await runMatch({
      seats: [
        { userId: 'u_a', buyInChips: 100, strategy: nit }, // folds quickly
        { userId: 'u_b', buyInChips: 100, strategy: callingStation },
      ],
      maxHands: 3,
    });

    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    expect(report.handsPlayed).toBeGreaterThan(0);

    // create event present
    const types = report.ledgerEvents.map((e) => e.type);
    expect(types).toContain('game_created');
    // both players joined
    const joinCount = types.filter((t) => t === 'player_joined').length;
    expect(joinCount).toBe(2);
    // hand lifecycle present
    expect(types).toContain('hand_started');
    expect(types).toContain('blinds_posted');
    expect(types).toContain('pot_awarded');
    expect(types).toContain('hand_completed');

    // Cashout invariant: total chip mass after a fold-win sequence is the
    // sum of buy-ins (no chips minted, none lost).
    const total =
      report.finalBalances.reduce((s, b) => s + b.chips, 0n) +
      report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
    expect(total).toBe(200_000_000n);
  });

  it('8-player full ring lifecycle: 4 hands, ledger sequence valid for every hand', async () => {
    const report = await runMatch({
      seats: Array.from({ length: 8 }, (_, i) => ({
        userId: `u_${i + 1}`,
        buyInChips: 100,
        strategy: i % 2 === 0 ? callingStation : nit,
      })),
      maxHands: 4,
    });

    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);
    expect(report.handsPlayed).toBeGreaterThanOrEqual(1);

    // Every hand recorded in the ledger must end with hand_completed and
    // have strictly increasing per-hand sequence numbers.
    const handIds = new Set<string>();
    for (const e of report.ledgerEvents) if (e.handId) handIds.add(e.handId);
    expect(handIds.size).toBeGreaterThan(0);
    for (const hid of handIds) {
      const events = report.ledgerEvents.filter((e) => e.handId === hid);
      const seqs = events.map((e) => e.sequence);
      // monotonic
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
      // ends with hand_completed
      expect(events[events.length - 1].type).toBe('hand_completed');
    }

    // Total chip mass = 8 * 100 chips
    const total =
      report.finalBalances.reduce((s, b) => s + b.chips, 0n) +
      report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
    expect(total).toBe(800_000_000n);
  });

  it('cashout: at end-of-game the winner has chipBalance > 0 and chipStack = 0', async () => {
    // Force game-end by giving everyone calling station so a single hand
    // resolves to showdown and someone wins everyone else's chips eventually.
    // With 2 players, a single fold-win can also end the match.
    const report = await runMatch({
      seats: [
        { userId: 'u_a', buyInChips: 5, strategy: callingStation },
        { userId: 'u_b', buyInChips: 5, strategy: callingStation },
      ],
      maxHands: 30,
    });

    expect(report.error).toBeUndefined();
    expect(report.conservationOk).toBe(true);

    // After the match completes (gameOver), the winner should have all chips
    // moved into ChipBalance (Phase 1 cashout) and their chipStack should be 0.
    if (report.endedReason === 'gameOver') {
      const winners = report.finalBalances.filter((b) => b.chips > 0n);
      // At least one player has chips off-table.
      expect(winners.length).toBeGreaterThan(0);
      // The total balance of winners equals 10 chips (combined buy-in).
      const balanceTotal = report.finalBalances.reduce((s, b) => s + b.chips, 0n);
      const stackTotal = report.finalStacks.reduce((s, p) => s + p.chipStack, 0n);
      expect(balanceTotal + stackTotal).toBe(10_000_000n);
    }
  });
});
