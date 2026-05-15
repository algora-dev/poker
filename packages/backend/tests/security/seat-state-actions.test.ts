/**
 * Anti-cheat phase 2 — dead-seat action rejection (audit-30 P2 / H-02).
 *
 * Gerald audit-30 priority #2: defence in depth. Under normal flow,
 * turn advancement skips folded / eliminated / all-in seats, so
 * activePlayerIndex should never land on one. But if any future bug
 * or race leaves the index on a dead seat, the player whose seat is
 * folded / eliminated / all-in must NOT be able to submit an action.
 *
 * This test forces `activePlayerIndex` onto each dead state and
 * confirms `processAction` rejects cleanly with NO mutation: no
 * gamePlayer.update, no handAction.create, no hand.update.
 *
 * Pre-fix evidence (Gerald audit-30 H-02 finding): `processAction`
 * validated activeIndex/userId and looked up the player, but did
 * NOT explicitly reject by `player.position` before the version
 * guard. The fix adds that explicit reject just before the H-02
 * guard runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 1n, bigBlind: 2n }),
}));

vi.mock('../../src/db/client', () => ({
  prisma: {
    $transaction: async (fn: any) => {
      const harness: any = (globalThis as any).__t3PokerTxHarness;
      if (!harness) throw new Error('no test harness installed');
      return fn(harness.tx);
    },
  },
}));

function buildDeadSeatHarness(playerPosition: 'folded' | 'eliminated' | 'all_in') {
  const calls: { model: string; method: string; args: any }[] = [];
  // The dead-seat player at activePlayerIndex 0. (In production this
  // shouldn't happen; we're testing the safety guard for when it does.)
  const storedHand = {
    id: 'h1',
    gameId: 'g1',
    stage: 'flop',
    pot: 5_000_000n,
    currentBet: 1_000_000n,
    activePlayerIndex: 0,
    version: 0,
    board: '[]',
    deck: '[]',
    turnStartedAt: new Date(),
  };
  const deadPlayer = {
    id: 'gp1',
    userId: 'u_dead',
    gameId: 'g1',
    chipStack: playerPosition === 'eliminated' ? 0n : 50_000_000n,
    position: playerPosition,
    seatIndex: 0,
  };
  const livePlayer = {
    id: 'gp2',
    userId: 'u_live',
    gameId: 'g1',
    chipStack: 100_000_000n,
    position: 'active',
    seatIndex: 1,
  };

  const tx: any = {
    game: {
      findUnique: vi.fn(async () => ({
        id: 'g1',
        status: 'in_progress',
        bigBlind: 2_000_000n,
        smallBlind: 1_000_000n,
        players: [deadPlayer, livePlayer].map((p: any) => ({
          ...p,
          user: { id: p.userId, username: p.userId },
        })),
        hands: [storedHand],
      })),
    },
    gamePlayer: {
      findFirst: vi.fn(async () => deadPlayer),
      findMany: vi.fn(async () => [deadPlayer, livePlayer]),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'gamePlayer', method: 'update', args });
        return deadPlayer;
      }),
    },
    hand: {
      findUnique: vi.fn(async () => storedHand),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'hand', method: 'update', args });
        return storedHand;
      }),
      updateMany: vi.fn(async (args: any) => {
        calls.push({ model: 'hand', method: 'updateMany', args });
        return { count: 1 };
      }),
    },
    handAction: {
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { amount: 0n } })),
      create: vi.fn(async (args: any) => {
        calls.push({ model: 'handAction', method: 'create', args });
        return args.data;
      }),
    },
    handEvent: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => {
        calls.push({ model: 'handEvent', method: 'create', args });
        return { id: 'he', sequenceNumber: args.data.sequenceNumber };
      }),
    },
  };

  return { tx, calls };
}

describe('Anti-cheat phase 2 — dead-seat action rejection (audit-30 H-02)', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  afterEach(() => {
    delete (globalThis as any).__t3PokerTxHarness;
  });

  // ─── folded ─────────────────────────────────────────────────────
  it.each(['fold', 'check', 'call', 'all-in'] as const)(
    'folded player cannot submit %s — no mutation',
    async (action) => {
      const harness = buildDeadSeatHarness('folded');
      (globalThis as any).__t3PokerTxHarness = harness;

      await expect(
        mod.processAction('g1', 'u_dead', action)
      ).rejects.toThrow(/cannot act|seat state/i);

      const mutations = harness.calls.filter(
        (c) =>
          (c.model === 'gamePlayer' && c.method === 'update') ||
          (c.model === 'handAction' && c.method === 'create') ||
          (c.model === 'hand' && c.method === 'update') ||
          (c.model === 'hand' && c.method === 'updateMany')
      );
      expect(
        mutations.length,
        `folded player ${action} should produce ZERO mutations, got: ${JSON.stringify(
          mutations.map((m) => `${m.model}.${m.method}`)
        )}`
      ).toBe(0);
    }
  );

  // Folded player attempting a raise (separate because raise has amount).
  it('folded player cannot submit raise — no mutation', async () => {
    const harness = buildDeadSeatHarness('folded');
    (globalThis as any).__t3PokerTxHarness = harness;

    await expect(
      mod.processAction('g1', 'u_dead', 'raise', 5)
    ).rejects.toThrow(/cannot act|seat state/i);

    const mutations = harness.calls.filter(
      (c) =>
        (c.model === 'gamePlayer' && c.method === 'update') ||
        (c.model === 'handAction' && c.method === 'create') ||
        (c.model === 'hand' && c.method === 'update') ||
        (c.model === 'hand' && c.method === 'updateMany')
    );
    expect(mutations.length).toBe(0);
  });

  // ─── eliminated ────────────────────────────────────────────────
  it.each(['fold', 'check', 'call', 'all-in'] as const)(
    'eliminated player cannot submit %s — no mutation',
    async (action) => {
      const harness = buildDeadSeatHarness('eliminated');
      (globalThis as any).__t3PokerTxHarness = harness;

      await expect(
        mod.processAction('g1', 'u_dead', action)
      ).rejects.toThrow(/cannot act|seat state/i);

      const mutations = harness.calls.filter(
        (c) =>
          (c.model === 'gamePlayer' && c.method === 'update') ||
          (c.model === 'handAction' && c.method === 'create') ||
          (c.model === 'hand' && c.method === 'update') ||
          (c.model === 'hand' && c.method === 'updateMany')
      );
      expect(mutations.length).toBe(0);
    }
  );

  // ─── all_in ────────────────────────────────────────────────────
  it.each(['fold', 'check', 'call', 'all-in'] as const)(
    'all-in player cannot submit %s — no mutation',
    async (action) => {
      const harness = buildDeadSeatHarness('all_in');
      (globalThis as any).__t3PokerTxHarness = harness;

      await expect(
        mod.processAction('g1', 'u_dead', action)
      ).rejects.toThrow(/cannot act|seat state/i);

      const mutations = harness.calls.filter(
        (c) =>
          (c.model === 'gamePlayer' && c.method === 'update') ||
          (c.model === 'handAction' && c.method === 'create') ||
          (c.model === 'hand' && c.method === 'update') ||
          (c.model === 'hand' && c.method === 'updateMany')
      );
      expect(mutations.length).toBe(0);
    }
  );

  // ─── reject runs BEFORE the H-02 guard ─────────────────────────
  // Cosmetic: confirm we never even ran the version-guard update.
  it('dead-seat reject fires BEFORE the H-02 version guard', async () => {
    const harness = buildDeadSeatHarness('folded');
    (globalThis as any).__t3PokerTxHarness = harness;

    await expect(
      mod.processAction('g1', 'u_dead', 'check')
    ).rejects.toThrow(/cannot act|seat state/i);

    const guardCalls = harness.calls.filter(
      (c) => c.model === 'hand' && c.method === 'updateMany'
    );
    expect(guardCalls.length).toBe(0);
  });
});
