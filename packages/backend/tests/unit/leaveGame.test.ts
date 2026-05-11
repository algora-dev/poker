/**
 * Unit tests for services/game.leaveGame.
 *
 * Coverage:
 *  1. Leaving a waiting game with other seated players:
 *      - chipStack refunded to ChipBalance
 *      - GamePlayer row deleted
 *      - ChipAudit + MoneyEvent + HandEvent rows written
 *      - mode='waiting_refund'
 *  2. Leaving a waiting game when you're the LAST seated player:
 *      - whole game cancelled via closeGameInTx
 *      - mode='closed_last_player'
 *  3. Leaving an in_progress game:
 *      - NO chip movement (chips locked until closeGame at natural end)
 *      - position flipped to 'eliminated'
 *      - HandEvent recorded
 *      - mode='in_progress_fold'
 *  4. Leaving when not seated:
 *      - mode='idempotent_noop', no DB writes
 *  5. Leaving a non-existent game:
 *      - mode='idempotent_noop'
 *
 * The mock prisma here is intentionally tiny — just enough surface for
 * the leaveGame() path. closeGameInTx is mocked to a fast stub so this
 * test stays focused on leaveGame's branching logic; closeGameInTx itself
 * is covered by chipConservation.test.ts and the harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));

// Mock the userMoneyMutex helper so we don't try to call pg_advisory_xact_lock.
vi.mock('../../src/services/userMoneyMutex', () => ({
  acquireUserMoneyMutex: vi.fn(async () => undefined),
}));

// Mock recordMoneyEvent + recordHandEvent.
const recordMoneyEventMock = vi.fn(async () => undefined);
const recordHandEventMock = vi.fn(async () => undefined);
vi.mock('../../src/services/moneyLedger', () => ({
  recordMoneyEvent: recordMoneyEventMock,
}));
vi.mock('../../src/services/handLedger', () => ({
  recordHandEvent: recordHandEventMock,
}));

// Mock closeGameInTx so we can detect path 1+last-player without re-running
// the full close-game ledger surface.
const closeGameInTxMock = vi.fn();
vi.mock('../../src/services/closeGame', () => ({
  closeGameInTx: closeGameInTxMock,
}));

interface MockState {
  game: any | null;
  players: any[];
  chipBalances: Map<string, bigint>;
  audits: any[];
  deletedSeatIds: string[];
}

/** Tiny in-memory prisma with $transaction semantics. */
function buildPrisma(initial: MockState) {
  const state = {
    game: initial.game ? { ...initial.game } : null,
    players: initial.players.map((p) => ({ ...p })),
    chipBalances: new Map(initial.chipBalances),
    audits: [] as any[],
    deletedSeatIds: [] as string[],
  };

  const tx: any = {
    game: {
      findUnique: vi.fn(async (args: any) => {
        if (!state.game || args.where.id !== state.game.id) return null;
        const out: any = { ...state.game };
        if (args.include?.players) {
          out.players = state.players.map((p) => ({ ...p }));
        }
        return out;
      }),
    },
    gamePlayer: {
      delete: vi.fn(async (args: any) => {
        const idx = state.players.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error('player not found');
        state.deletedSeatIds.push(state.players[idx].id);
        state.players.splice(idx, 1);
        return null;
      }),
      update: vi.fn(async (args: any) => {
        const idx = state.players.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error('player not found');
        Object.assign(state.players[idx], args.data);
        return state.players[idx];
      }),
    },
    chipBalance: {
      findUnique: vi.fn(async (args: any) => {
        const chips = state.chipBalances.get(args.where.userId);
        if (chips == null) return null;
        return { userId: args.where.userId, chips };
      }),
      update: vi.fn(async (args: any) => {
        const cur = state.chipBalances.get(args.where.userId) ?? 0n;
        const inc =
          args.data.chips?.increment != null
            ? BigInt(args.data.chips.increment)
            : 0n;
        const next = cur + inc;
        state.chipBalances.set(args.where.userId, next);
        return { userId: args.where.userId, chips: next };
      }),
    },
    chipAudit: {
      create: vi.fn(async (args: any) => {
        state.audits.push(args.data);
        return args.data;
      }),
    },
  };

  const client = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return { client, state, tx };
}

describe('leaveGame', () => {
  beforeEach(() => {
    vi.resetModules();
    recordMoneyEventMock.mockClear();
    recordHandEventMock.mockClear();
    closeGameInTxMock.mockReset();
  });

  it('waiting + others remain: refunds chipStack, deletes seat, writes ledger', async () => {
    const { client, state } = buildPrisma({
      game: {
        id: 'g1',
        name: 'TestGame',
        status: 'waiting',
        maxPlayers: 9,
      },
      players: [
        { id: 'p1', userId: 'u1', gameId: 'g1', seatIndex: 0, chipStack: 5_000_000n, position: 'waiting' },
        { id: 'p2', userId: 'u2', gameId: 'g1', seatIndex: 1, chipStack: 5_000_000n, position: 'waiting' },
      ],
      chipBalances: new Map([['u1', 10_000_000n], ['u2', 5_000_000n]]),
      audits: [],
      deletedSeatIds: [],
    });

    vi.doMock('../../src/db/client', () => ({ prisma: client }));
    const { leaveGame } = await import('../../src/services/game');

    const result = await leaveGame('u1', 'g1');

    expect(result.mode).toBe('waiting_refund');
    expect(result.refundAmount).toBe('5000000');
    // Off-table balance went up by exactly the stack.
    expect(state.chipBalances.get('u1')).toBe(15_000_000n);
    // Seat row gone.
    expect(state.deletedSeatIds).toEqual(['p1']);
    // The other player is untouched.
    expect(state.players.length).toBe(1);
    expect(state.players[0].userId).toBe('u2');
    // Ledger calls happened.
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].operation).toBe('game_leave_refund');
    expect(state.audits[0].amountDelta).toBe(5_000_000n);
    expect(recordMoneyEventMock).toHaveBeenCalledTimes(1);
    expect(recordHandEventMock).toHaveBeenCalledTimes(1);
    expect(recordHandEventMock.mock.calls[0][1].eventType).toBe('player_left');
    // closeGameInTx must NOT have been called (others remain).
    expect(closeGameInTxMock).not.toHaveBeenCalled();
  });

  it('waiting + last player: cancels whole game via closeGameInTx', async () => {
    const { client, state } = buildPrisma({
      game: { id: 'g2', name: 'Solo', status: 'waiting', maxPlayers: 9 },
      players: [
        { id: 'p_solo', userId: 'u_solo', gameId: 'g2', seatIndex: 0, chipStack: 10_000_000n, position: 'waiting' },
      ],
      chipBalances: new Map([['u_solo', 0n]]),
      audits: [],
      deletedSeatIds: [],
    });

    closeGameInTxMock.mockImplementation(async (_tx: any, _input: any) => ({
      gameId: 'g2',
      reason: 'pre_start_cancel',
      newStatus: 'cancelled',
      refundedPlayers: [
        { userId: 'u_solo', refundAmount: 10_000_000n, newBalance: 10_000_000n },
      ],
      totalRefunded: 10_000_000n,
    }));

    vi.doMock('../../src/db/client', () => ({ prisma: client }));
    const { leaveGame } = await import('../../src/services/game');

    const result = await leaveGame('u_solo', 'g2');

    expect(result.mode).toBe('closed_last_player');
    expect(result.refundAmount).toBe('10000000');
    expect(result.gameStatusAfter).toBe('cancelled');
    expect(closeGameInTxMock).toHaveBeenCalledTimes(1);
    expect(closeGameInTxMock.mock.calls[0][1].reason).toBe('pre_start_cancel');
    // We did NOT do an inline refund path on top of closeGameInTx.
    expect(state.audits).toHaveLength(0);
    // Also did not delete the row inline (closeGameInTx zeros chipStack
    // but leaves the row; the mock doesn't simulate that delete here).
    expect(state.deletedSeatIds).toEqual([]);
  });

  it('in_progress: marks seat eliminated, NO chip movement', async () => {
    const { client, state } = buildPrisma({
      game: { id: 'g3', name: 'Live', status: 'in_progress', maxPlayers: 9 },
      players: [
        { id: 'p_live', userId: 'u_live', gameId: 'g3', seatIndex: 0, chipStack: 7_000_000n, position: 'active' },
        { id: 'p_b', userId: 'u_b', gameId: 'g3', seatIndex: 1, chipStack: 5_000_000n, position: 'active' },
      ],
      chipBalances: new Map([['u_live', 0n], ['u_b', 0n]]),
      audits: [],
      deletedSeatIds: [],
    });

    vi.doMock('../../src/db/client', () => ({ prisma: client }));
    const { leaveGame } = await import('../../src/services/game');

    const result = await leaveGame('u_live', 'g3');

    expect(result.mode).toBe('in_progress_fold');
    expect(result.gameStatusAfter).toBe('in_progress');
    // No chip movement.
    expect(state.chipBalances.get('u_live')).toBe(0n);
    expect(state.audits).toHaveLength(0);
    expect(recordMoneyEventMock).not.toHaveBeenCalled();
    // Seat still there, position flipped.
    expect(state.players.length).toBe(2);
    const leaver = state.players.find((p) => p.userId === 'u_live')!;
    expect(leaver.position).toBe('eliminated');
    expect(BigInt(leaver.chipStack)).toBe(7_000_000n); // stack preserved
    // Hand event recorded.
    expect(recordHandEventMock).toHaveBeenCalledTimes(1);
    expect(recordHandEventMock.mock.calls[0][1].payload.mode).toBe('in_progress_fold');
    expect(closeGameInTxMock).not.toHaveBeenCalled();
  });

  it('not seated at this game: idempotent_noop, no side-effects', async () => {
    const { client, state } = buildPrisma({
      game: { id: 'g4', name: 'NotMine', status: 'waiting', maxPlayers: 9 },
      players: [
        { id: 'p_other', userId: 'u_other', gameId: 'g4', seatIndex: 0, chipStack: 5_000_000n, position: 'waiting' },
      ],
      chipBalances: new Map([['u_stranger', 99n], ['u_other', 0n]]),
      audits: [],
      deletedSeatIds: [],
    });

    vi.doMock('../../src/db/client', () => ({ prisma: client }));
    const { leaveGame } = await import('../../src/services/game');

    const result = await leaveGame('u_stranger', 'g4');

    expect(result.mode).toBe('idempotent_noop');
    // No side-effects anywhere.
    expect(state.chipBalances.get('u_stranger')).toBe(99n);
    expect(state.audits).toHaveLength(0);
    expect(state.deletedSeatIds).toEqual([]);
    expect(recordHandEventMock).not.toHaveBeenCalled();
    expect(closeGameInTxMock).not.toHaveBeenCalled();
  });

  it('game does not exist: idempotent_noop', async () => {
    const { client } = buildPrisma({
      game: null,
      players: [],
      chipBalances: new Map(),
      audits: [],
      deletedSeatIds: [],
    });

    vi.doMock('../../src/db/client', () => ({ prisma: client }));
    const { leaveGame } = await import('../../src/services/game');

    const result = await leaveGame('u_anon', 'g_gone');
    expect(result.mode).toBe('idempotent_noop');
    expect(result.gameStatusAfter).toBe('unknown');
  });
});
