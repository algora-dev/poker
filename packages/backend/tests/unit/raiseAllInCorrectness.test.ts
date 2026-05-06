/**
 * Phase 2 — Raise / all-in correctness
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 2 and findings [H-01], [M-01]:
 *
 *   H-01: Oversized raise must NOT set currentBet to the requested target
 *         when the player is capped at their stack. currentBet must reflect
 *         actual contribution.
 *
 *   M-01: A short all-in (whose increment over the current high-water bet is
 *         less than the last legal raise increment) must NOT reopen action.
 *         Original aggressor cannot be forced to re-respond.
 *
 * These tests drive checkBettingComplete (action-reopening) and the raise
 * branch of processAction with crafted mock transactions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub appLogger so processAction's failure path does not import config.
vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));

// Stub blindSchedule (used by checkGameContinuation indirectly).
vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 1n, bigBlind: 2n }),
}));

// Stub prisma client. The $transaction function reads a per-test harness from
// globalThis so individual tests can swap in their own mock tx.
vi.mock('../../src/db/client', () => ({
  prisma: {
    $transaction: async (fn: any) => {
      const harness: any = (globalThis as any).__t3PokerTxHarness;
      if (!harness) throw new Error('no test harness installed');
      return fn(harness.tx);
    },
  },
}));

// ---------------------------------------------------------------------------
// checkBettingComplete tests (M-01 + sanity for normal flow)
// ---------------------------------------------------------------------------

interface ActionRow {
  userId: string;
  action: 'blind' | 'check' | 'call' | 'raise' | 'fold' | 'all-in';
  amount?: bigint;
  stage: string;
  timestamp?: Date;
}

interface PlayerRow {
  userId: string;
  position: 'active' | 'all_in' | 'folded' | 'eliminated';
  seatIndex: number;
}

function buildBettingTx(opts: {
  hand: { id: string; gameId: string; stage: string; currentBet?: bigint };
  game: { id: string; bigBlind: bigint };
  actions: ActionRow[];
  players: PlayerRow[];
}) {
  return {
    hand: {
      findUnique: vi.fn(async () => opts.hand),
    },
    handAction: {
      findMany: vi.fn(async () =>
        opts.actions
          .filter((a) => a.stage === opts.hand.stage)
          .map((a, idx) => ({
            ...a,
            timestamp: a.timestamp ?? new Date(idx),
          }))
      ),
    },
    game: {
      findUnique: vi.fn(async () => opts.game),
    },
    gamePlayer: {
      findMany: vi.fn(async () => opts.players),
    },
  } as any;
}

describe('Phase 2 [M-01] — checkBettingComplete: short all-in does NOT reopen action', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  it('full legal raise reopens action: original aggressor must respond again', async () => {
    // Preflop. SB=1, BB=2. P1 raises to 6 (legal min-raise: incr 4 over BB=2).
    // P2 (bb) re-raises to 14 (legal: incr 8 >= last incr 4). After P2, P1 has
    // not yet acted SINCE P2's raise → betting NOT complete.
    const tx = buildBettingTx({
      hand: { id: 'h1', gameId: 'g1', stage: 'preflop' },
      game: { id: 'g1', bigBlind: 2n },
      actions: [
        { userId: 'p1', action: 'blind', amount: 1n, stage: 'preflop' },
        { userId: 'p2', action: 'blind', amount: 2n, stage: 'preflop' },
        { userId: 'p1', action: 'raise', amount: 5n, stage: 'preflop' }, // total 6
        { userId: 'p2', action: 'raise', amount: 12n, stage: 'preflop' }, // total 14
      ],
      players: [
        { userId: 'p1', position: 'active', seatIndex: 0 },
        { userId: 'p2', position: 'active', seatIndex: 1 },
      ],
    });

    const complete = await mod.checkBettingComplete(tx, 'h1', []);
    expect(complete).toBe(false);
  });

  it('short all-in does NOT reopen action: P1 only needs to CALL (not re-raise) to close the round', async () => {
    // Preflop. BB=2. P1 raises to 10 (incr 8 over BB).
    // P2 short-all-in for 14 (incr 4 over high-water 10, last incr was 8).
    // 4 < 8 → does NOT reopen. P1 still owes 4 to call the new high-water.
    // Once P1 just CALLS the extra 4 (no re-raise required), action is complete.
    const tx = buildBettingTx({
      hand: { id: 'h1', gameId: 'g1', stage: 'preflop' },
      game: { id: 'g1', bigBlind: 2n },
      actions: [
        { userId: 'p1', action: 'blind', amount: 1n, stage: 'preflop' },
        { userId: 'p2', action: 'blind', amount: 2n, stage: 'preflop' },
        { userId: 'p1', action: 'raise', amount: 9n, stage: 'preflop' }, // total 10, incr 8 over BB
        { userId: 'p2', action: 'all-in', amount: 12n, stage: 'preflop' }, // total 14, incr 4 (short)
        { userId: 'p1', action: 'call', amount: 4n, stage: 'preflop' }, // total 14, just calling
      ],
      players: [
        { userId: 'p1', position: 'active', seatIndex: 0 },
        { userId: 'p2', position: 'all_in', seatIndex: 1 },
      ],
    });

    // P1's last action was a call, but lastAggressorId must still point to P1
    // (the original full raiser) since the short all-in did NOT reopen.
    // playersWhoCanAct = [p1] (p2 is all_in). p1 has acted since the (still)
    // last legal raise (p1 themselves), bets match (both 14 cumulative). Done.
    const complete = await mod.checkBettingComplete(tx, 'h1', []);
    expect(complete).toBe(true);
  });

  it('all-in legal full raise DOES reopen action: original aggressor must respond', async () => {
    // BB=2. P1 raises to 10 (incr 8). P2 calls 10. P3 all-in for total 20
    // (incr 10 over high-water 10, last incr was 8 → 10 >= 8, reopens).
    // After P3, P1 has not acted since P3's raise → not complete.
    const tx = buildBettingTx({
      hand: { id: 'h1', gameId: 'g1', stage: 'preflop' },
      game: { id: 'g1', bigBlind: 2n },
      actions: [
        { userId: 'p1', action: 'blind', amount: 1n, stage: 'preflop' },
        { userId: 'p2', action: 'blind', amount: 2n, stage: 'preflop' },
        { userId: 'p1', action: 'raise', amount: 9n, stage: 'preflop' }, // total 10
        { userId: 'p2', action: 'call', amount: 8n, stage: 'preflop' }, // total 10
        { userId: 'p3', action: 'all-in', amount: 20n, stage: 'preflop' }, // total 20, incr 10
      ],
      players: [
        { userId: 'p1', position: 'active', seatIndex: 0 },
        { userId: 'p2', position: 'active', seatIndex: 1 },
        { userId: 'p3', position: 'all_in', seatIndex: 2 },
      ],
    });

    const complete = await mod.checkBettingComplete(tx, 'h1', []);
    expect(complete).toBe(false);
  });

  it('all-in equal to call (no raise) does not reopen action and counts as response', async () => {
    // BB=2. P1 raises to 10 (incr 8). P2 short-stacked all-in for exactly 10
    // (incr 0). 0 < 8 → does NOT reopen. P1 already acted as the aggressor;
    // betting is complete.
    const tx = buildBettingTx({
      hand: { id: 'h1', gameId: 'g1', stage: 'preflop' },
      game: { id: 'g1', bigBlind: 2n },
      actions: [
        { userId: 'p1', action: 'blind', amount: 1n, stage: 'preflop' },
        { userId: 'p2', action: 'blind', amount: 2n, stage: 'preflop' },
        { userId: 'p1', action: 'raise', amount: 9n, stage: 'preflop' }, // total 10
        { userId: 'p2', action: 'all-in', amount: 8n, stage: 'preflop' }, // total 10, incr 0
      ],
      players: [
        { userId: 'p1', position: 'active', seatIndex: 0 },
        { userId: 'p2', position: 'all_in', seatIndex: 1 },
      ],
    });

    const complete = await mod.checkBettingComplete(tx, 'h1', []);
    expect(complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processAction.raise tests (H-01)
// ---------------------------------------------------------------------------

/**
 * Build a full-fat mock prisma transaction client for processAction's raise
 * branch. We track all `hand.update` and `gamePlayer.update` calls so we can
 * assert what currentBet got written.
 */
function buildProcessActionTx(opts: {
  game: any;
  hand: any;
  player: any;
  stageActions: ActionRow[];
}) {
  const calls: { model: string; method: string; args: any }[] = [];
  let storedHand = { ...opts.hand };
  let storedPlayer = { ...opts.player };

  // Pretend there's also a second player so betting does not auto-complete
  // after our acting player's single action.
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
        players: [opts.player, otherPlayer].map((p: any) => ({
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

  // processAction does prisma.$transaction(async (tx) => ...) on the real
  // prisma client. We wrap our mock tx so the call resolves with our tx.
  const $transaction = async (fn: (t: any) => Promise<any>) => fn(tx);

  return { tx, $transaction, calls, storedHandRef: () => storedHand, storedPlayerRef: () => storedPlayer };
}

describe('Phase 2 [H-01] — raise branch: currentBet reflects actual contribution', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  afterEach(() => {
    delete (globalThis as any).__t3PokerTxHarness;
  });

  it('short-stacked oversized raise sets currentBet to actual contribution, not requested target', async () => {
    // Setup: heads-up preflop. BB=2_000_000 (=2.0 chips at 6 decimals).
    // currentBet so far = 2_000_000 (BB level). P1 has only 5_000_000 chips
    // and submits a "raise" to 100_000_000 (100 chips). They can only put in
    // their remaining 5_000_000 (after blind). currentBet must become 5_000_000,
    // not 100_000_000. Note the raise UI uses fractional chip units.
    //
    // We model it as: P1 already has 1_000_000 in (small blind), chipStack
    // remaining = 4_000_000. They request raise to 100 chips total
    // (raiseTotalBigInt = 100_000_000). actionAmount = 100_000_000 - 1_000_000
    // = 99_000_000, capped to chipStack 4_000_000. actualTotalContribution
    // = 1_000_000 + 4_000_000 = 5_000_000. currentBet must = 5_000_000.
    const harness = buildProcessActionTx({
      game: {
        id: 'g1',
        status: 'in_progress',
        bigBlind: 2_000_000n,
        smallBlind: 1_000_000n,
      },
      hand: {
        id: 'h1',
        gameId: 'g1',
        stage: 'preflop',
        pot: 3_000_000n, // SB+BB
        currentBet: 2_000_000n, // BB level
        activePlayerIndex: 0,
        board: '[]',
        deck: '[]',
      },
      player: {
        id: 'gp1',
        userId: 'u1',
        gameId: 'g1',
        chipStack: 4_000_000n, // very short
        position: 'active',
        seatIndex: 0,
      },
      stageActions: [
        // Existing blinds
        { userId: 'u1', action: 'blind', amount: 1_000_000n, stage: 'preflop' },
        { userId: 'u2', action: 'blind', amount: 2_000_000n, stage: 'preflop' },
      ],
    });
    (globalThis as any).__t3PokerTxHarness = harness;

    // raiseAmount in pokerActions is in CHIP UNITS (multiplied by 1_000_000).
    // The function does Math.floor(raiseAmount * 1_000_000), so passing 100
    // means a target of 100_000_000 micro-chips.
    await mod.processAction('g1', 'u1', 'raise', 100).catch((err) => {
      // The flow may throw during downstream pipeline (next-player resolution
      // etc.) because we are not modeling the full game. We only care about
      // the hand.update call that recorded currentBet.
      // Re-throw if it's an early validation error (would mean raise rejected).
      if (
        err &&
        typeof err.message === 'string' &&
        /Raise|Invalid|Not your turn|active hand|Game is not/.test(err.message)
      ) {
        throw err;
      }
    });

    // Any hand.update that records currentBet must be the actual paid total
    // (5_000_000), never the requested 100_000_000. The downstream stage
    // advance may also reset currentBet to 0, which is fine — just never the
    // requested oversize value.
    const handUpdates = harness.calls.filter(
      (c) => c.model === 'hand' && c.method === 'update'
    );
    for (const u of handUpdates) {
      if (u.args.data?.currentBet != null) {
        expect(u.args.data.currentBet).not.toBe(100_000_000n);
        expect(u.args.data.currentBet).toBeLessThanOrEqual(5_000_000n);
      }
    }
    // Player's chipStack must be exactly 0 after the all-in shove.
    expect(harness.storedPlayerRef().chipStack).toBe(0n);
    expect(harness.storedPlayerRef().position).toBe('all_in');
  });

  it('normal raise (no stack capping) sets currentBet to requested raise total', async () => {
    // BB=2_000_000. P1 has 100_000_000 chips, raises to 6_000_000 (3xBB).
    // Min-raise increment = BB = 2_000_000; new bet 6_000_000 > minRaiseTotal
    // (currentBet=2_000_000 + lastIncr=2_000_000 = 4_000_000) → legal.
    // actualTotalContribution = 0 + 6_000_000 = 6_000_000. currentBet → 6_000_000.
    const harness = buildProcessActionTx({
      game: {
        id: 'g1',
        status: 'in_progress',
        bigBlind: 2_000_000n,
        smallBlind: 1_000_000n,
      },
      hand: {
        id: 'h1',
        gameId: 'g1',
        stage: 'preflop',
        pot: 3_000_000n,
        currentBet: 2_000_000n,
        activePlayerIndex: 0,
        board: '[]',
        deck: '[]',
      },
      player: {
        id: 'gp1',
        userId: 'u1',
        gameId: 'g1',
        chipStack: 100_000_000n,
        position: 'active',
        seatIndex: 0,
      },
      stageActions: [
        { userId: 'u1', action: 'blind', amount: 1_000_000n, stage: 'preflop' },
        { userId: 'u2', action: 'blind', amount: 2_000_000n, stage: 'preflop' },
      ],
    });
    (globalThis as any).__t3PokerTxHarness = harness;

    await mod.processAction('g1', 'u1', 'raise', 6).catch((err) => {
      if (
        err &&
        typeof err.message === 'string' &&
        /Raise|Invalid|Not your turn|active hand|Game is not/.test(err.message)
      ) {
        throw err;
      }
    });

    // The first hand.update that touches currentBet should set it to 6_000_000
    // (1_000_000 SB already in + 5_000_000 new contribution = actual total).
    const handUpdates = harness.calls.filter(
      (c) => c.model === 'hand' && c.method === 'update'
    );
    const firstBetWrite = handUpdates.find(
      (u) => u.args.data?.currentBet != null
    );
    expect(firstBetWrite).toBeDefined();
    expect(firstBetWrite!.args.data.currentBet).toBe(6_000_000n);
  });

  it('raise below minimum (and not all-in) is rejected', async () => {
    // BB=2_000_000. currentBet=2_000_000. lastIncr=BB=2_000_000.
    // minRaiseTotal = 4_000_000. Raising to 3_000_000 is below min and the
    // player has plenty of chips, so it must be rejected.
    const harness = buildProcessActionTx({
      game: {
        id: 'g1',
        status: 'in_progress',
        bigBlind: 2_000_000n,
        smallBlind: 1_000_000n,
      },
      hand: {
        id: 'h1',
        gameId: 'g1',
        stage: 'preflop',
        pot: 3_000_000n,
        currentBet: 2_000_000n,
        activePlayerIndex: 0,
        board: '[]',
        deck: '[]',
      },
      player: {
        id: 'gp1',
        userId: 'u1',
        gameId: 'g1',
        chipStack: 100_000_000n,
        position: 'active',
        seatIndex: 0,
      },
      stageActions: [
        { userId: 'u1', action: 'blind', amount: 1_000_000n, stage: 'preflop' },
        { userId: 'u2', action: 'blind', amount: 2_000_000n, stage: 'preflop' },
      ],
    });
    (globalThis as any).__t3PokerTxHarness = harness;

    await expect(
      mod.processAction('g1', 'u1', 'raise', 3) // 3 chip total < min-raise 4
    ).rejects.toThrow(/min-raise/i);
  });
});
