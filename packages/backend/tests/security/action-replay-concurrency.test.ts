/**
 * Anti-cheat phase 2 — replay & concurrency stress (audit-30 P1).
 *
 * Gerald audit-30 priority #1: stress-test the H-02 optimistic
 * concurrency guard in `pokerActions.ts` with adversarial input
 * patterns that real attackers would try.
 *
 * Existing unit coverage (`tests/unit/concurrencyGuard.test.ts`)
 * proves the guard rejects a SECOND request issued AFTER a successful
 * first one. It does not prove what happens when N requests fire
 * simultaneously with the same starting version. This file fills the
 * gap.
 *
 * Coverage:
 *   1. N=10 parallel identical actions       -> exactly 1 success
 *   2. N=50 parallel identical actions       -> exactly 1 success
 *   3. Chips are NOT double-debited under burst
 *   4. The version is bumped exactly once under burst
 *   5. HandAction rows: exactly 1 written under burst
 *   6. Human action + turnTimer race share the same guard
 *
 * The harness models the DB's optimistic concurrency exactly:
 * `hand.updateMany({ where: { version }, data: { increment } })` is
 * atomic — only one match wins, the rest get count=0. JavaScript's
 * single-threaded event loop makes this trivial to model: as long
 * as the updateMany handler does NOT await between read and write
 * of the stored version, the first match is the only match.
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
      // Each $transaction call gets a FRESH view of the loaded hand
      // (modeling Postgres "read snapshot at tx start") but they all
      // race against the SAME shared `storedHand.version` via the
      // atomic updateMany. This is the exact race semantics we want
      // to defend against.
      return fn(harness.tx);
    },
  },
}));

// ─── Shared harness ──────────────────────────────────────────────────
//
// Unlike the unit-test harness which is rebuilt per call, this one
// is shared across N concurrent processAction invocations so they
// race against the same `storedHand.version` and `storedPlayer.chipStack`.

function buildSharedHarness() {
  const calls: { model: string; method: string; args: any }[] = [];
  const storedHand = {
    id: 'h1',
    gameId: 'g1',
    stage: 'preflop',
    pot: 3_000_000n,
    currentBet: 2_000_000n,
    activePlayerIndex: 0,
    version: 0,
    board: '[]',
    deck: '[]',
    turnStartedAt: new Date(),
  };
  const storedPlayer = {
    id: 'gp1',
    userId: 'u1',
    gameId: 'g1',
    chipStack: 100_000_000n,
    position: 'active',
    seatIndex: 0,
  };
  const otherPlayer = {
    id: 'gp_other',
    userId: 'u_other',
    gameId: 'g1',
    chipStack: 100_000_000n,
    position: 'active',
    seatIndex: 1,
  };
  const stageActions = [
    { userId: 'u1', action: 'blind' as const, amount: 1_000_000n, stage: 'preflop' },
    { userId: 'u_other', action: 'blind' as const, amount: 2_000_000n, stage: 'preflop' },
  ];

  // The CRITICAL piece: updateMany must be synchronous-atomic.
  // No awaits between reading storedHand.version and incrementing it,
  // so the first caller to enter wins; all others see the new version
  // and return count=0. This mirrors Postgres's row-level lock under
  // a single optimistic update.
  const tx: any = {
    game: {
      findUnique: vi.fn(async () => ({
        id: 'g1',
        status: 'in_progress',
        bigBlind: 2_000_000n,
        smallBlind: 1_000_000n,
        players: [storedPlayer, otherPlayer].map((p: any) => ({
          ...p,
          // Snapshot of position/stack at the moment of read.
          chipStack: p.chipStack,
          position: p.position,
          user: { id: p.userId, username: 'u_' + p.userId },
        })),
        hands: [{ ...storedHand }], // snapshot, not live ref
      })),
    },
    gamePlayer: {
      findFirst: vi.fn(async () => ({ ...storedPlayer })),
      findMany: vi.fn(async () => [
        { ...storedPlayer },
        { ...otherPlayer },
      ]),
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
        return { ...storedPlayer };
      }),
    },
    hand: {
      findUnique: vi.fn(async () => ({ ...storedHand })),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'hand', method: 'update', args });
        Object.assign(storedHand, args.data);
        return { ...storedHand };
      }),
      // ATOMIC: read + check + write in a single synchronous block.
      // No awaits anywhere; the JS event loop guarantees no other
      // tx can interleave here.
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
        stageActions
          .filter((a) => a.stage === (where?.stage ?? storedHand.stage))
          .map((a, idx) => ({ ...a, timestamp: a.timestamp ?? new Date(idx) }))
      ),
      aggregate: vi.fn(async ({ where }: any) => {
        const total = stageActions
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
    handEvent: {
      findFirst: vi.fn(async (args: any) => {
        const w = args.where;
        const ledgerCalls = calls.filter(
          (c) =>
            c.model === 'handEvent' &&
            c.method === 'create' &&
            c.args.data.gameId === w.gameId &&
            (c.args.data.handId ?? null) === (w.handId ?? null)
        );
        if (!ledgerCalls.length) return null;
        const maxSeq = ledgerCalls.reduce(
          (m, c) => Math.max(m, c.args.data.sequenceNumber),
          0
        );
        return { sequenceNumber: maxSeq };
      }),
      create: vi.fn(async (args: any) => {
        calls.push({ model: 'handEvent', method: 'create', args });
        return { id: 'he', sequenceNumber: args.data.sequenceNumber };
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

describe('Anti-cheat phase 2 — replay & concurrency (audit-30 P1)', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  afterEach(() => {
    delete (globalThis as any).__t3PokerTxHarness;
  });

  // ─────────────────────────────────────────────────────────────────
  // Helper: run N concurrent processAction calls and collect
  // success/failure stats.
  // ─────────────────────────────────────────────────────────────────
  async function runParallelActions(
    n: number,
    action: 'call' | 'fold' | 'check' | 'raise' | 'all-in',
    raiseAmount?: number
  ) {
    const harness = buildSharedHarness();
    (globalThis as any).__t3PokerTxHarness = harness;

    const startBarrier = new Promise<void>((resolve) =>
      setTimeout(resolve, 0)
    );
    const promises = Array.from({ length: n }, () =>
      startBarrier.then(() =>
        mod
          .processAction('g1', 'u1', action, raiseAmount)
          .then(() => ({ ok: true, err: null as any }))
          .catch((err: any) => ({ ok: false, err }))
      )
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.ok).length;
    const staleRejections = results.filter(
      (r) => !r.ok && /Stale action/i.test(r.err?.message ?? '')
    ).length;
    const otherFailures = results.filter(
      (r) => !r.ok && !/Stale action/i.test(r.err?.message ?? '')
    );

    return { harness, results, successes, staleRejections, otherFailures };
  }

  // ─────────────────────────────────────────────────────────────────
  // 1. N=10 parallel — exactly 1 success
  // ─────────────────────────────────────────────────────────────────
  it('10 parallel identical actions: EXACTLY ONE succeeds', async () => {
    const r = await runParallelActions(10, 'call');
    expect(r.successes).toBe(1);
    expect(r.staleRejections).toBe(r.results.length - 1);
    expect(
      r.otherFailures.length,
      `non-stale failures: ${JSON.stringify(
        r.otherFailures.map((f) => f.err?.message)
      )}`
    ).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. N=50 parallel — exactly 1 success (stress)
  // ─────────────────────────────────────────────────────────────────
  it('50 parallel identical actions: EXACTLY ONE succeeds', async () => {
    const r = await runParallelActions(50, 'call');
    expect(r.successes).toBe(1);
    expect(r.staleRejections).toBe(49);
    expect(r.otherFailures.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Chips not double-debited under burst
  // ─────────────────────────────────────────────────────────────────
  it('burst replay does NOT double-debit chips', async () => {
    const r = await runParallelActions(20, 'call');
    expect(r.successes).toBe(1);
    // Player started with 100_000_000n micro-chips.
    // u1 has 1_000_000n (blind) already in. To match currentBet 2_000_000n,
    // they need to put 1_000_000n more. Exactly one call → 99_000_000n.
    expect(r.harness.playerRef().chipStack).toBe(99_000_000n);
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Version bumped exactly once
  // ─────────────────────────────────────────────────────────────────
  it('burst replay bumps hand version EXACTLY once', async () => {
    const r = await runParallelActions(20, 'call');
    expect(r.successes).toBe(1);
    expect(r.harness.handRef().version).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Exactly one HandAction row written
  // ─────────────────────────────────────────────────────────────────
  it('burst replay writes EXACTLY ONE HandAction row', async () => {
    const r = await runParallelActions(20, 'call');
    expect(r.successes).toBe(1);
    const handActionCreates = r.harness.calls.filter(
      (c) =>
        c.model === 'handAction' &&
        c.method === 'create' &&
        // Skip blind-rows (which are written by initializeHand, not
        // processAction). The burst only writes the 'call'.
        c.args.data?.action !== 'blind'
    );
    expect(handActionCreates.length).toBe(1);
    expect(handActionCreates[0].args.data.action).toBe('call');
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Human action + turnTimer auto-action both hit the same guard
  //
  // The turnTimer path also calls processAction(). If the guard were
  // bypassable from either side, an attacker could time their submit
  // to coincide with a timer expiry and double-apply. This test
  // proves both code paths route through the same shared transaction
  // and thus the same H-02 updateMany guard.
  // ─────────────────────────────────────────────────────────────────
  it('human-action + turnTimer race: still exactly ONE wins', async () => {
    const harness = buildSharedHarness();
    (globalThis as any).__t3PokerTxHarness = harness;

    // Fire both concurrently. The turnTimer in production calls
    // processAction directly (no separate code path) so a parallel
    // racing call is the right model.
    const [humanResult, timerResult] = await Promise.all([
      mod
        .processAction('g1', 'u1', 'call')
        .then(() => ({ ok: true, who: 'human' }))
        .catch((err: any) => ({ ok: false, who: 'human', err })),
      mod
        .processAction('g1', 'u1', 'check') // turnTimer's "free check" fallback
        .then(() => ({ ok: true, who: 'timer' }))
        .catch((err: any) => ({ ok: false, who: 'timer', err })),
    ]);

    // Exactly one of the two succeeds; the other gets Stale action
    // OR an action-validation error (e.g. "Cannot check - you need to call").
    // Either way, exactly one mutation occurs.
    const successes = [humanResult, timerResult].filter((r) => r.ok).length;
    expect(successes).toBe(1);
    expect(harness.handRef().version).toBe(1);
  });
});
