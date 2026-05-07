/**
 * Phase 1 — Chip Conservation Invariants
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 1:
 *   - Hand winners must NOT mint withdrawable chips (ChipBalance).
 *   - Pot awards go to GamePlayer.chipStack only.
 *   - ChipBalance is touched only at boundaries: deposit, buy-in, leave-table/cashout,
 *     refund, withdrawal, admin correction.
 *   - Sum(ChipBalance) + Sum(live chipStack) is conserved across hand actions.
 *
 * Tests drive the real handleFoldWin / handleShowdown paths against an in-memory
 * mock Prisma transaction client. They assert no `game_win` ChipBalance credit
 * is ever produced during hand resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock blindSchedule so checkGameContinuation does not try to import live config.
vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 1n, bigBlind: 2n }),
}));

// Mock appLogger to avoid DB writes from logging paths.
vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));

// Mock the hand evaluator so chip-conservation tests focus only on the
// award-flow contract. Hand-evaluator correctness is tested separately.
// We encode the test-side intent (winners) in the holeCards JSON itself
// using a small marker shape: [{ _testTag: 'X', strength: N }, ...]
// The mocked evaluateHand returns a HandResult-like object carrying that
// strength; compareHands sorts on it.
vi.mock('../../src/services/poker/handEvaluator', () => ({
  evaluateHand: (hole: any[], _board: any) => {
    const strength = Array.isArray(hole) && hole[0]?.strength ? hole[0].strength : 0;
    return { rank: strength, description: 'mocked', cards: [], strength };
  },
  compareHands: (a: any, b: any) => (a.strength ?? 0) - (b.strength ?? 0),
}));

// Mock sidePots: deterministic single-pot allocation for deterministic tests.
vi.mock('../../src/services/sidePots', () => ({
  calculateSidePots: vi.fn(async (_tx: any, _handId: string, players: any[]) => {
    const eligible = players
      .filter((p) => p.position !== 'folded' && p.position !== 'eliminated')
      .map((p) => p.userId);
    return [
      {
        potNumber: 1,
        amount: 200n,
        eligiblePlayerIds: eligible,
      },
    ];
  }),
  storeSidePots: vi.fn(async () => {}),
  getSidePots: vi.fn(async () => []),
}));

// Build a deterministic in-memory tx that records every call so assertions are
// straightforward and chip flows are easy to inspect.
function buildMockTx(initial: {
  players: Array<{
    id: string;
    userId: string;
    seatIndex: number;
    chipStack: bigint;
    position: string;
    holeCards?: string;
    user: { id: string; username: string };
  }>;
  balances: Array<{ userId: string; chips: bigint }>;
  game: any;
  hand: any;
}) {
  const players = initial.players.map((p) => ({ ...p }));
  const balances = new Map<string, bigint>(
    initial.balances.map((b) => [b.userId, b.chips])
  );
  const audits: any[] = [];
  const calls: { model: string; method: string; args: any }[] = [];

  const tx: any = {
    gamePlayer: {
      findMany: vi.fn(async (args: any) => {
        calls.push({ model: 'gamePlayer', method: 'findMany', args });
        let rows = players.slice();
        if (args?.orderBy?.seatIndex === 'asc') {
          rows.sort((a, b) => a.seatIndex - b.seatIndex);
        }
        return rows;
      }),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'gamePlayer', method: 'update', args });
        const idx = players.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error('player not found');
        const data = args.data;
        if (data.chipStack != null) {
          if (typeof data.chipStack === 'object' && data.chipStack.increment != null) {
            players[idx].chipStack += BigInt(data.chipStack.increment);
          } else {
            // Direct assignment (e.g. zeroing on cashout).
            players[idx].chipStack = BigInt(data.chipStack);
          }
        }
        if (typeof data.position === 'string') {
          players[idx].position = data.position;
        }
        return players[idx];
      }),
    },
    chipBalance: {
      findUnique: vi.fn(async (args: any) => {
        calls.push({ model: 'chipBalance', method: 'findUnique', args });
        const userId = args.where.userId;
        if (!balances.has(userId)) return null;
        return { userId, chips: balances.get(userId)! };
      }),
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'chipBalance', method: 'update', args });
        const userId = args.where.userId;
        const before = balances.get(userId) ?? 0n;
        const delta = BigInt(args.data.chips.increment);
        balances.set(userId, before + delta);
        return { userId, chips: before + delta };
      }),
    },
    chipAudit: {
      create: vi.fn(async (args: any) => {
        calls.push({ model: 'chipAudit', method: 'create', args });
        audits.push(args.data);
        return args.data;
      }),
    },
    hand: {
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'hand', method: 'update', args });
        return args.data;
      }),
    },
    game: {
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'game', method: 'update', args });
        if (args.data?.status) {
          // Mirror the status flip back into the in-memory game so the
          // closeGame helper's idempotency check (game.status already
          // closed) sees the right value across nested calls.
          (initial.game as any).status = args.data.status;
        }
        return args.data;
      }),
      // Phase 10 [H-01]: closeGameInTx reads game + open hands + players.
      // Build the response from the same in-memory state the test mutates.
      findUnique: vi.fn(async (args: any) => {
        calls.push({ model: 'game', method: 'findUnique', args });
        if (args.where.id !== initial.game.id) return null;
        const includePlayers = args.include?.players;
        const includeHands = args.include?.hands;
        const sortedPlayers = includePlayers
          ? players
              .slice()
              .sort((a, b) => a.seatIndex - b.seatIndex)
              .map((p) => ({ ...p }))
          : undefined;
        const handRow = initial.hand
          ? { ...initial.hand, stage: (initial.hand as any).stage ?? 'river' }
          : null;
        const hands = includeHands
          ? handRow && handRow.stage !== 'completed'
            ? [handRow]
            : []
          : undefined;
        return {
          ...(initial.game as any),
          status: (initial.game as any).status ?? 'in_progress',
          players: sortedPlayers,
          hands,
        };
      }),
    },
    sidePot: {
      update: vi.fn(async (args: any) => {
        calls.push({ model: 'sidePot', method: 'update', args });
        return args.data;
      }),
    },
    // Phase 10 [H-01]: closeGameInTx reads handAction for pot-share refunds
    // (cancel paths). For natural_completion paths it skips the read, but
    // we provide a no-op default so other tests don't choke either.
    handAction: {
      findMany: vi.fn(async (args: any) => {
        calls.push({ model: 'handAction', method: 'findMany', args });
        return [];
      }),
    },
    // Phase 9: MoneyEvent ledger. closeGame writes one row per refund.
    moneyEvent: {
      create: vi.fn(async (args: any) => {
        calls.push({ model: 'moneyEvent', method: 'create', args });
        return { id: 'me', ...args.data };
      }),
    },
    // Phase 7 [M-05]: handEvent ledger stub. Sequence numbering matches the
    // real Postgres unique index (gameId, handId, sequenceNumber).
    handEvent: {
      findFirst: vi.fn(async (args: any) => {
        const w = args.where;
        const matches = audits
          .filter((_e) => false) // audits is for chipAudit; ledger uses its own list
          .map(() => null);
        // ledger events are tracked via the calls list; reconstruct max-seq.
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

  return { tx, players, balances, audits, calls };
}

function totalChipStack(players: { chipStack: bigint; position: string }[]) {
  return players.reduce((sum, p) => sum + p.chipStack, 0n);
}

function totalBalances(balances: Map<string, bigint>) {
  return Array.from(balances.values()).reduce((sum, v) => sum + v, 0n);
}

describe('Phase 1 — chip conservation: fold-win path', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  it('credits pot only to chipStack, never to ChipBalance, and conserves total chips', async () => {
    // Setup: 2 players, each bought in for 100. One folds, the other wins a 200 pot.
    const { tx, players, balances, audits, calls } = buildMockTx({
      players: [
        {
          id: 'gp_alice',
          userId: 'u_alice',
          seatIndex: 0,
          chipStack: 0n, // both put their full stacks into the pot for this test
          position: 'active',
          user: { id: 'u_alice', username: 'alice' },
        },
        {
          id: 'gp_bob',
          userId: 'u_bob',
          seatIndex: 1,
          chipStack: 0n,
          position: 'folded',
          user: { id: 'u_bob', username: 'bob' },
        },
      ],
      // ChipBalance reflects the off-table portion AFTER buy-in (untouched here).
      balances: [
        { userId: 'u_alice', chips: 0n },
        { userId: 'u_bob', chips: 0n },
      ],
      game: { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      hand: { id: 'h1', pot: 200n, stage: 'river' },
    });

    const winner = players[0];
    // Total chip mass = chipStacks + balances + pot-in-flight.
    const totalBefore = totalChipStack(players) + totalBalances(balances) + 200n; // 200n is the pot in flight

    await mod.handleFoldWin(tx as any, { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 }, { id: 'h1', pot: 200n }, winner);

    // Invariant 1: the entire pot ended up with Alice. Because Bob was
    // eliminated (0 chips), the game ends and Alice's stack is cashed out
    // into her ChipBalance. Stack is zeroed; balance now holds 200.
    const alice = players.find((p) => p.id === 'gp_alice')!;
    expect(alice.chipStack).toBe(0n);
    expect(balances.get('u_alice')).toBe(200n);

    // Invariant 2: ChipBalance was NOT credited for the win itself.
    const winAudits = audits.filter((a) => a.operation === 'game_win');
    expect(winAudits).toEqual([]);

    // Invariant 3: NO chipBalance.update was called with a `game_win` audit.
    const balanceUpdates = calls.filter(
      (c) => c.model === 'chipBalance' && c.method === 'update'
    );
    // The only balance updates allowed are end-of-game refunds (operation game_cashout).
    // checkGameContinuation will detect 1 player remaining and refund Alice's 200.
    expect(balanceUpdates.length).toBe(1);
    const refundAudits = audits.filter((a) => a.operation === 'game_cashout');
    expect(refundAudits.length).toBe(1);
    expect(refundAudits[0].amountDelta).toBe(200n);

    // Invariant 4: total chip mass conserved.
    // After end-of-game refund, Alice's 200 chipStack moves into ChipBalance.
    // No more pot in flight, so totalAfter = chipStacks + balances and that
    // must equal totalBefore (which included the in-flight pot).
    const totalAfter = totalChipStack(players) + totalBalances(balances);
    expect(totalAfter).toBe(totalBefore);
  });

  it('a player who buys in 100, wins a 200 pot, gets exactly 200 credited at cashout (not 400)', async () => {
    // This is the regression test for the original double-credit bug.
    // Bob already paid his 100 into the pot. Alice still has her 100 chipStack.
    const { tx, players, balances, audits } = buildMockTx({
      players: [
        {
          id: 'gp_alice',
          userId: 'u_alice',
          seatIndex: 0,
          chipStack: 100n, // her remaining stack after committing nothing yet
          position: 'active',
          user: { id: 'u_alice', username: 'alice' },
        },
        {
          id: 'gp_bob',
          userId: 'u_bob',
          seatIndex: 1,
          chipStack: 0n,
          position: 'folded',
          user: { id: 'u_bob', username: 'bob' },
        },
      ],
      balances: [
        { userId: 'u_alice', chips: 0n }, // off-table = 0 after buy-in
        { userId: 'u_bob', chips: 0n },
      ],
      game: { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      hand: { id: 'h1', pot: 200n },
    });

    await mod.handleFoldWin(
      tx as any,
      { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      { id: 'h1', pot: 200n },
      players[0]
    );

    // Alice should end with exactly 300 in her ChipBalance (her original 100 stack +
    // the 200 she won), NOT 500 (the bug would have credited 200 from win + 300 from cashout).
    expect(balances.get('u_alice')).toBe(300n);
    expect(balances.get('u_bob')).toBe(0n);

    // Exactly one audit row for the cashout, none for the win.
    expect(audits.filter((a) => a.operation === 'game_win')).toEqual([]);
    const cashouts = audits.filter((a) => a.operation === 'game_cashout');
    expect(cashouts.length).toBe(1);
    expect(cashouts[0].amountDelta).toBe(300n);
  });
});

describe('Phase 1 — chip conservation: showdown path', () => {
  let mod: typeof import('../../src/services/pokerActions');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  it('showdown awards pot only to chipStack and never credits ChipBalance for the win', async () => {
    // Bob wins via mocked evaluator (strength 2 > Alice strength 1).
    const board = JSON.stringify([]);
    const aliceHole = JSON.stringify([{ strength: 1 }]);
    const bobHole = JSON.stringify([{ strength: 2 }]);

    const { tx, players, balances, audits, calls } = buildMockTx({
      players: [
        {
          id: 'gp_alice',
          userId: 'u_alice',
          seatIndex: 0,
          chipStack: 0n,
          position: 'active',
          holeCards: aliceHole,
          user: { id: 'u_alice', username: 'alice' },
        },
        {
          id: 'gp_bob',
          userId: 'u_bob',
          seatIndex: 1,
          chipStack: 0n,
          position: 'active',
          holeCards: bobHole,
          user: { id: 'u_bob', username: 'bob' },
        },
      ],
      balances: [
        { userId: 'u_alice', chips: 0n },
        { userId: 'u_bob', chips: 0n },
      ],
      game: { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      hand: { id: 'h1', pot: 200n, board },
    });

    await mod.handleShowdown(
      tx as any,
      { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      { id: 'h1', pot: 200n, board }
    );

    // The 200 pot should land entirely on Bob, who is then cashed out at
    // game-end (Alice was eliminated at 0). Final destination: Bob's balance = 200.
    const bob = players.find((p) => p.id === 'gp_bob')!;
    const alice = players.find((p) => p.id === 'gp_alice')!;
    expect(balances.get('u_bob')).toBe(200n);
    expect(balances.get('u_alice')).toBe(0n);
    // Stacks must be zeroed at cashout so chips are not held in two places.
    expect(bob.chipStack).toBe(0n);
    expect(alice.chipStack).toBe(0n);

    // No game_win audits should ever be created.
    expect(audits.filter((a) => a.operation === 'game_win')).toEqual([]);

    // The only ChipBalance updates should be the end-of-game refunds.
    const balanceUpdates = calls.filter(
      (c) => c.model === 'chipBalance' && c.method === 'update'
    );
    expect(balanceUpdates.length).toBe(1);
  });

  it('split pot is awarded only to chipStacks (no ChipBalance mint)', async () => {
    // Identical strength → split pot via mocked evaluator.
    const board = JSON.stringify([]);
    const aliceHole = JSON.stringify([{ strength: 5 }]);
    const bobHole = JSON.stringify([{ strength: 5 }]);

    const { tx, players, balances, audits } = buildMockTx({
      players: [
        {
          id: 'gp_alice',
          userId: 'u_alice',
          seatIndex: 0,
          chipStack: 0n,
          position: 'active',
          holeCards: aliceHole,
          user: { id: 'u_alice', username: 'alice' },
        },
        {
          id: 'gp_bob',
          userId: 'u_bob',
          seatIndex: 1,
          chipStack: 0n,
          position: 'active',
          holeCards: bobHole,
          user: { id: 'u_bob', username: 'bob' },
        },
      ],
      balances: [
        { userId: 'u_alice', chips: 0n },
        { userId: 'u_bob', chips: 0n },
      ],
      game: { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      hand: { id: 'h1', pot: 200n, board },
    });

    await mod.handleShowdown(
      tx as any,
      { id: 'g1', name: 'test', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      { id: 'h1', pot: 200n, board }
    );

    // Each splits 100 of the 200 pot into their chipStack. Both still alive
    // (>0 chips), so the game does NOT end and no cashout fires. Off-table
    // balances must remain untouched.
    const alice = players.find((p) => p.id === 'gp_alice')!;
    const bob = players.find((p) => p.id === 'gp_bob')!;
    expect(alice.chipStack).toBe(100n);
    expect(bob.chipStack).toBe(100n);
    expect(balances.get('u_alice')).toBe(0n);
    expect(balances.get('u_bob')).toBe(0n);

    // No game_win audits, no cashout audits.
    expect(audits.filter((a) => a.operation === 'game_win')).toEqual([]);
    expect(audits.filter((a) => a.operation === 'game_cashout')).toEqual([]);
  });
});

describe('Phase 1 — boundary check: only legitimate operations touch ChipBalance', () => {
  it("hand resolution never produces an audit row with operation 'game_win'", async () => {
    // Sanity grep: walk the source and assert no 'game_win' literal exists in
    // pokerActions.ts. This codifies the rule; if a future change reintroduces
    // the bug, this test fires immediately.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../../src/services/pokerActions.ts'),
      'utf8'
    );
    expect(src.includes("'game_win'")).toBe(false);
    expect(src.includes('"game_win"')).toBe(false);
  });
});
