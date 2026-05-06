/**
 * Phase 3 — Optimistic concurrency guard on hand actions
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 3 and finding [H-02]:
 *   - Two near-simultaneous requests from the active player must not both
 *     pass turn validation and double-apply.
 *   - Add a version (or equivalent) guard. Exactly one request advances the
 *     turn. Stale actions reject cleanly.
 *
 * These tests drive processAction with a controlled in-memory tx where the
 * guard's updateMany behaves like a real DB row-version check. We then call
 * processAction twice with the same starting state and assert the second
 * call is rejected and chips are not double-deducted.
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

// Per-test harness from globalThis (set in each test). Same pattern used by
// the Phase 2 raise tests; the prisma mock is module-level so vi.mock
// hoisting is happy.
vi.mock('../../src/db/client', () => ({
  prisma: {
    $transaction: async (fn: any) => {
      const harness: any = (globalThis as any).__t3PokerTxHarness;
      if (!harness) throw new Error('no test harness installed');
      return fn(harness.tx);
    },
  },
}));

interface ActionRow {
  userId: string;
  action: 'blind' | 'check' | 'call' | 'raise' | 'fold' | 'all-in';
  amount?: bigint;
  stage: string;
  timestamp?: Date;
}

/**
 * Build a tx where hand.updateMany simulates real DB optimistic-concurrency:
 * matches only when {id, activePlayerIndex, stage, version} all match the
 * current stored hand. On match, increments version. Returns {count}.
 */
function buildGuardedTx(initialHand: any, initialPlayer: any, opts: { game: any; stageActions: ActionRow[] }) {
  const calls: { model: string; method: string; args: any }[] = [];
  let storedHand = { ...initialHand };
  let storedPlayer = { ...initialPlayer };
  const otherPlayer: any = {
    id: 'gp_other',
    userId: 'u_other',
    gameId: opts.game.id,
    chipStack: 100_000_000n,
    position: 'active',
    seatIndex: 1,
  };

  const tx: any = {
    game: {
      findUnique: vi.fn(async () => ({
        ...opts.game,
        players: [storedPlayer, otherPlayer].map((p: any) => ({
          ...p,
          user: { id: p.userId, username: 'u_' + p.userId },
        })),
        hands: [storedHand],
      })),
    },
    gamePlayer: {
      findFirst: vi.fn(async () => storedPlayer),
      findMany: vi.fn(async () => [storedPlayer, otherPlayer]),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'gamePlayer', method: 'update', args });
        if (args.data.chipStack != null) {
          if (typeof args.data.chipStack === 'object') {
            storedPlayer.chipStack += BigInt(args.data.chipStack.increment);
          } else {
            storedPlayer.chipStack = BigInt(args.data.chipStack);
          }
        }
        if (typeof args.data.position === 'string') {
          storedPlayer.position = args.data.position;
        }
        return storedPlayer;
      }),
    },
    hand: {
      findUnique: vi.fn(async () => storedHand),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'hand', method: 'update', args });
        storedHand = { ...storedHand, ...args.data };
        return storedHand;
      }),
      // Simulates real Postgres optimistic-concurrency: predicate match +
      // atomic update. Returns count=1 on match, count=0 otherwise.
      updateMany: vi.fn(async (args: any) => {
        calls.push({ model: 'hand', method: 'updateMany', args });
        const w = args.where;
        const matches =
          w.id === storedHand.id &&
          w.activePlayerIndex === storedHand.activePlayerIndex &&
          w.stage === storedHand.stage &&
          w.version === storedHand.version;
        if (!matches) return { count: 0 };
        // Apply increment.
        if (args.data?.version?.increment != null) {
          storedHand.version += args.data.version.increment;
        }
        return { count: 1 };
      }),
    },
    handAction: {
      findMany: vi.fn(async ({ where }: any) =>
        opts.stageActions
          .filter((a) => a.stage === (where?.stage ?? storedHand.stage))
          .map((a, idx) => ({ ...a, timestamp: a.timestamp ?? new Date(idx) }))
      ),
      aggregate: vi.fn(async ({ where }: any) => {
        const total = opts.stageActions
          .filter(
            (a) =>
              (where.userId == null || a.userId === where.userId) &&
              (where.stage == null || a.stage === where.stage)
          )
          .reduce((sum, a) => sum + (a.amount || 0n), 0n);
        return { _sum: { amount: total } };
      }),
      create: vi.fn(async (args: any) => {
        calls.push({ model: 'handAction', method: 'create', args });
        return args.data;
      }),
    },
  };

  return {
    tx,
    calls,
    handRef: () => storedHand,
    playerRef: () => storedPlayer,
  };
}

describe('Phase 3 [H-02] — optimistic concurrency guard', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  afterEach(() => {
    delete (globalThis as any).__t3PokerTxHarness;
  });

  it('first action succeeds and bumps version exactly once', async () => {
    const harness = buildGuardedTx(
      {
        id: 'h1',
        gameId: 'g1',
        stage: 'preflop',
        pot: 3_000_000n,
        currentBet: 2_000_000n,
        activePlayerIndex: 0,
        version: 0,
        board: '[]',
        deck: '[]',
      },
      {
        id: 'gp1',
        userId: 'u1',
        gameId: 'g1',
        chipStack: 100_000_000n,
        position: 'active',
        seatIndex: 0,
      },
      {
        game: {
          id: 'g1',
          status: 'in_progress',
          bigBlind: 2_000_000n,
          smallBlind: 1_000_000n,
        },
        stageActions: [
          { userId: 'u1', action: 'blind', amount: 1_000_000n, stage: 'preflop' },
          { userId: 'u_other', action: 'blind', amount: 2_000_000n, stage: 'preflop' },
        ],
      }
    );
    (globalThis as any).__t3PokerTxHarness = harness;

    await mod.processAction('g1', 'u1', 'call').catch((err: any) => {
      // Tolerate downstream resolution noise (next-player rotation etc.)
      // but rethrow if the guard itself fired.
      if (/Stale action|Not your turn/.test(err?.message ?? '')) throw err;
    });

    // Guard must have run exactly once and matched.
    const guardCalls = harness.calls.filter(
      (c) => c.model === 'hand' && c.method === 'updateMany'
    );
    expect(guardCalls.length).toBe(1);
    // Version must have advanced from 0 to 1.
    expect(harness.handRef().version).toBe(1);
  });

  it('duplicate request with the SAME starting version is rejected as stale', async () => {
    // Simulate two near-simultaneous requests: both load the same hand
    // (version 0) and both try to apply 'call'. The first one succeeds
    // (version becomes 1). The second guard runs against version 0 and
    // must see count=0 -> Stale action.
    const initialHand = {
      id: 'h1',
      gameId: 'g1',
      stage: 'preflop',
      pot: 3_000_000n,
      currentBet: 2_000_000n,
      activePlayerIndex: 0,
      version: 0,
      board: '[]',
      deck: '[]',
    };
    const initialPlayer = {
      id: 'gp1',
      userId: 'u1',
      gameId: 'g1',
      chipStack: 100_000_000n,
      position: 'active',
      seatIndex: 0,
    };
    const opts = {
      game: {
        id: 'g1',
        status: 'in_progress',
        bigBlind: 2_000_000n,
        smallBlind: 1_000_000n,
      },
      stageActions: [
        { userId: 'u1', action: 'blind' as const, amount: 1_000_000n, stage: 'preflop' },
        { userId: 'u_other', action: 'blind' as const, amount: 2_000_000n, stage: 'preflop' },
      ],
    };

    const harness = buildGuardedTx(initialHand, initialPlayer, opts);
    (globalThis as any).__t3PokerTxHarness = harness;

    // First call: should succeed.
    await mod.processAction('g1', 'u1', 'call').catch((err: any) => {
      if (/Stale action/.test(err?.message ?? '')) throw err;
    });
    expect(harness.handRef().version).toBe(1);

    // Now simulate a "stale" duplicate. We rebuild the harness starting from
    // a hand record whose version is still 0 (as if the second request
    // captured state before the first request committed) but where the DB's
    // current state already shows version 1. The simplest way to model this
    // in our in-memory tx: install a NEW harness whose stored hand is at
    // version 1, but the request thinks (via the loaded `currentHand`) it's
    // at version 0. We do that by lying about the loaded hand: set
    // game.findUnique to return a hand snapshot with version 0, while the
    // updateMany mock checks against the stored version of 1.
    const staleHarness = (() => {
      const calls: any[] = [];
      // Stored hand is already at version 1 (committed by the first action).
      let storedHand: any = { ...initialHand, version: 1, activePlayerIndex: 1 };
      let storedPlayer: any = { ...initialPlayer, chipStack: 99_000_000n };
      const otherPlayer: any = {
        id: 'gp_other',
        userId: 'u_other',
        gameId: opts.game.id,
        chipStack: 100_000_000n,
        position: 'active',
        seatIndex: 1,
      };
      // The "loaded" view that processAction sees is STALE (version 0,
      // activePlayerIndex 0) — modeling the read-then-write race.
      const stalePlayersView = [
        { ...storedPlayer, user: { id: storedPlayer.userId, username: 'u1' } },
        { ...otherPlayer, user: { id: otherPlayer.userId, username: 'u_other' } },
      ];
      const staleHandView = { ...initialHand, version: 0 };
      const tx: any = {
        game: {
          findUnique: vi.fn(async () => ({
            ...opts.game,
            players: stalePlayersView,
            hands: [staleHandView], // stale snapshot
          })),
        },
        gamePlayer: {
          findFirst: vi.fn(async () => storedPlayer),
          findMany: vi.fn(async () => [storedPlayer, otherPlayer]),
          update: vi.fn(async (args: any) => {
            calls.push({ model: 'gamePlayer', method: 'update', args });
            if (args.data.chipStack != null) {
              if (typeof args.data.chipStack === 'object') {
                storedPlayer.chipStack += BigInt(args.data.chipStack.increment);
              } else {
                storedPlayer.chipStack = BigInt(args.data.chipStack);
              }
            }
            if (typeof args.data.position === 'string') {
              storedPlayer.position = args.data.position;
            }
            return storedPlayer;
          }),
        },
        hand: {
          findUnique: vi.fn(async () => storedHand),
          update: vi.fn(async (args: any) => {
            calls.push({ model: 'hand', method: 'update', args });
            storedHand = { ...storedHand, ...args.data };
            return storedHand;
          }),
          updateMany: vi.fn(async (args: any) => {
            calls.push({ model: 'hand', method: 'updateMany', args });
            const w = args.where;
            const matches =
              w.id === storedHand.id &&
              w.activePlayerIndex === storedHand.activePlayerIndex &&
              w.stage === storedHand.stage &&
              w.version === storedHand.version;
            if (!matches) return { count: 0 };
            if (args.data?.version?.increment != null) {
              storedHand.version += args.data.version.increment;
            }
            return { count: 1 };
          }),
        },
        handAction: {
          findMany: vi.fn(async ({ where }: any) =>
            opts.stageActions
              .filter((a) => a.stage === (where?.stage ?? storedHand.stage))
              .map((a, idx) => ({ ...a, timestamp: a.timestamp ?? new Date(idx) }))
          ),
          aggregate: vi.fn(async ({ where }: any) => {
            const total = opts.stageActions
              .filter(
                (a) =>
                  (where.userId == null || a.userId === where.userId) &&
                  (where.stage == null || a.stage === where.stage)
              )
              .reduce((sum, a) => sum + (a.amount || 0n), 0n);
            return { _sum: { amount: total } };
          }),
          create: vi.fn(async (args: any) => {
            calls.push({ model: 'handAction', method: 'create', args });
            return args.data;
          }),
        },
      };
      return { tx, calls, storedHandRef: () => storedHand, storedPlayerRef: () => storedPlayer };
    })();
    (globalThis as any).__t3PokerTxHarness = staleHarness;

    // Second call must reject as Stale action. processAction should pass
    // turn validation (the stale view says it's u1's turn) but the guard
    // updateMany returns count=0 because real version is 1, not 0.
    // Note: the loaded view shows activePlayerIndex 0 -> u1 active. Real
    // state has activePlayerIndex 1 -> u_other. So the validation passes
    // (stale read), then the guard fires with count=0. Exactly the race
    // we want to defend against.
    await expect(mod.processAction('g1', 'u1', 'call')).rejects.toThrow(
      /Stale action/
    );

    // Crucially: chips must NOT have been double-deducted. The stale call
    // should not have produced any gamePlayer.update for chip deduction.
    const playerUpdates = staleHarness.calls.filter(
      (c) => c.model === 'gamePlayer' && c.method === 'update'
    );
    expect(playerUpdates.length).toBe(0);
    // Stored player chips unchanged from where we left off (99_000_000).
    expect(staleHarness.storedPlayerRef().chipStack).toBe(99_000_000n);
  });
});
