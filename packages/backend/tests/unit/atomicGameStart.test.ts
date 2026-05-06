/**
 * Phase 5 — Atomic game start / first hand initialization
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 5 and finding [H-05]:
 *   - Status flip to 'in_progress' must NOT commit before the first hand
 *     is initialized.
 *   - On init failure, the transaction must roll back; status stays 'waiting'.
 *   - Repeated start requests must be idempotent: only the first one
 *     transitions; subsequent calls get a clean rejection.
 *
 * Tests inject a mock prisma client that simulates real $transaction semantics
 * (commit-on-success, rollback-on-throw) and observe atomicStartGame's
 * behavior under success/failure/race conditions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));

/**
 * Tiny in-memory prisma stub with rollback-on-throw $transaction semantics.
 * We model just enough of the API for atomicStartGame + initializeHand to
 * run, with a snapshot/restore around each $transaction call.
 */
function buildMockPrisma(initial: {
  game: any;
  players: any[];
  hands?: any[];
  // injected failure for testing rollback
  failOnHandCreate?: boolean;
}) {
  let game = { ...initial.game };
  let players = initial.players.map((p) => ({ ...p }));
  let hands = (initial.hands || []).map((h) => ({ ...h }));
  let handActions: any[] = [];
  let handEvents: any[] = [];

  const buildTx = () => ({
    game: {
      findUnique: vi.fn(async (args: any) => {
        if (args.where.id !== game.id) return null;
        const out: any = { ...game };
        if (args.include?.players) {
          out.players = players
            .slice()
            .sort((a, b) => a.seatIndex - b.seatIndex)
            .map((p) => ({ ...p, user: { id: p.userId, username: 'u_' + p.userId } }));
        }
        return out;
      }),
      update: vi.fn(async (args: any) => {
        Object.assign(game, args.data);
        return game;
      }),
      updateMany: vi.fn(async (args: any) => {
        const w = args.where;
        if (w.id !== game.id) return { count: 0 };
        if (w.status != null && game.status !== w.status) return { count: 0 };
        Object.assign(game, args.data);
        return { count: 1 };
      }),
    },
    gamePlayer: {
      update: vi.fn(async (args: any) => {
        const idx = players.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error('player not found');
        const data = args.data;
        if (data.chipStack?.decrement != null) {
          players[idx].chipStack -= BigInt(data.chipStack.decrement);
        }
        if (typeof data.position === 'string') players[idx].position = data.position;
        if (typeof data.holeCards === 'string') players[idx].holeCards = data.holeCards;
        return players[idx];
      }),
    },
    hand: {
      count: vi.fn(async () => hands.length),
      create: vi.fn(async (args: any) => {
        if (initial.failOnHandCreate) {
          throw new Error('simulated init failure');
        }
        const created = { id: 'h_' + (hands.length + 1), ...args.data };
        hands.push(created);
        return created;
      }),
    },
    handAction: {
      create: vi.fn(async (args: any) => {
        handActions.push(args.data);
        return args.data;
      }),
    },
    // Phase 7 [M-05]: handEvent ledger stub. Honors per-(gameId, handId)
    // monotonic sequence assignment.
    handEvent: {
      findFirst: vi.fn(async (args: any) => {
        const w = args.where;
        const matches = handEvents.filter(
          (e) =>
            e.gameId === w.gameId &&
            (e.handId ?? null) === (w.handId ?? null)
        );
        if (!matches.length) return null;
        matches.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        return { sequenceNumber: matches[0].sequenceNumber };
      }),
      create: vi.fn(async (args: any) => {
        handEvents.push({
          gameId: args.data.gameId,
          handId: args.data.handId ?? null,
          sequenceNumber: args.data.sequenceNumber,
          eventType: args.data.eventType,
        });
        return { id: 'he_' + handEvents.length, sequenceNumber: args.data.sequenceNumber };
      }),
    },
  });

  const client = {
    $transaction: vi.fn(async (fn: any) => {
      // Snapshot for rollback.
      const gameSnap = { ...game };
      const playersSnap = players.map((p) => ({ ...p }));
      const handsSnap = hands.map((h) => ({ ...h }));
      const actionsSnap = handActions.slice();
      const eventsSnap = handEvents.slice();
      try {
        return await fn(buildTx());
      } catch (err) {
        // Rollback to snapshot.
        game = gameSnap;
        players = playersSnap;
        hands = handsSnap;
        handActions = actionsSnap;
        handEvents = eventsSnap;
        throw err;
      }
    }),
  };

  return {
    client,
    state: () => ({ game, players, hands, handActions, handEvents }),
  };
}

describe('Phase 5 [H-05] — atomicStartGame', () => {
  let mod: typeof import('../../src/services/holdemGame');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/holdemGame');
  });

  it('successful start commits status flip AND first hand atomically', async () => {
    const harness = buildMockPrisma({
      game: {
        id: 'g1',
        status: 'waiting',
        dealerIndex: 0,
        smallBlind: 1n,
        bigBlind: 2n,
      },
      players: [
        {
          id: 'gp1',
          userId: 'u1',
          gameId: 'g1',
          seatIndex: 0,
          chipStack: 100n,
          position: 'active',
          holeCards: '[]',
        },
        {
          id: 'gp2',
          userId: 'u2',
          gameId: 'g1',
          seatIndex: 1,
          chipStack: 100n,
          position: 'active',
          holeCards: '[]',
        },
      ],
    });

    const result = await mod.atomicStartGame('g1', harness.client as any);

    expect(result.ok).toBe(true);
    const s = harness.state();
    expect(s.game.status).toBe('in_progress');
    expect(s.game.startedAt).toBeInstanceOf(Date);
    // Exactly one hand was created.
    expect(s.hands.length).toBe(1);
    expect(s.hands[0].handNumber).toBe(1);
    // Blinds were posted on both seats (decremented by SB/BB).
    expect(s.players.find((p) => p.id === 'gp1')!.chipStack).toBe(99n); // SB = 1 (heads-up: dealer is SB)
    expect(s.players.find((p) => p.id === 'gp2')!.chipStack).toBe(98n); // BB = 2
  });

  it('failed hand initialization rolls back: status stays waiting, no hand created', async () => {
    const harness = buildMockPrisma({
      game: {
        id: 'g1',
        status: 'waiting',
        dealerIndex: 0,
        smallBlind: 1n,
        bigBlind: 2n,
      },
      players: [
        {
          id: 'gp1',
          userId: 'u1',
          gameId: 'g1',
          seatIndex: 0,
          chipStack: 100n,
          position: 'active',
          holeCards: '[]',
        },
        {
          id: 'gp2',
          userId: 'u2',
          gameId: 'g1',
          seatIndex: 1,
          chipStack: 100n,
          position: 'active',
          holeCards: '[]',
        },
      ],
      failOnHandCreate: true, // simulate failure inside initializeHand
    });

    const result = await mod.atomicStartGame('g1', harness.client as any);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe('init_failed');
    }
    const s = harness.state();
    // CRITICAL: rollback restored 'waiting'. No broken in_progress state.
    expect(s.game.status).toBe('waiting');
    expect(s.game.startedAt).toBeUndefined();
    expect(s.hands.length).toBe(0);
    // Player chip stacks unchanged.
    expect(s.players.find((p) => p.id === 'gp1')!.chipStack).toBe(100n);
    expect(s.players.find((p) => p.id === 'gp2')!.chipStack).toBe(100n);
  });

  it('repeated start request is idempotent: second call rejects with already_started', async () => {
    const harness = buildMockPrisma({
      game: {
        id: 'g1',
        status: 'waiting',
        dealerIndex: 0,
        smallBlind: 1n,
        bigBlind: 2n,
      },
      players: [
        {
          id: 'gp1',
          userId: 'u1',
          gameId: 'g1',
          seatIndex: 0,
          chipStack: 100n,
          position: 'active',
          holeCards: '[]',
        },
        {
          id: 'gp2',
          userId: 'u2',
          gameId: 'g1',
          seatIndex: 1,
          chipStack: 100n,
          position: 'active',
          holeCards: '[]',
        },
      ],
    });

    const first = await mod.atomicStartGame('g1', harness.client as any);
    expect(first.ok).toBe(true);

    // Second call: status guard (status: 'waiting') no longer matches.
    const second = await mod.atomicStartGame('g1', harness.client as any);
    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.code).toBe('already_started');
    }
    // Still exactly one hand.
    expect(harness.state().hands.length).toBe(1);
  });

  it('start on a non-waiting game (e.g. completed) is rejected without side effects', async () => {
    const harness = buildMockPrisma({
      game: {
        id: 'g1',
        status: 'completed',
        dealerIndex: 0,
        smallBlind: 1n,
        bigBlind: 2n,
      },
      players: [],
    });

    const result = await mod.atomicStartGame('g1', harness.client as any);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe('already_started');
    }
    expect(harness.state().game.status).toBe('completed');
    expect(harness.state().hands.length).toBe(0);
  });
});
