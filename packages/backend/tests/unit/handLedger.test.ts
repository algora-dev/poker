/**
 * Phase 7 — Hand event ledger
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 7 and finding [M-05]:
 *   - Append-only ledger with per-(gameId, handId) sequence numbers.
 *   - Mid-hand events MUST NOT include private hole cards.
 *   - All canonical event types are accepted; unknown types are rejected.
 *   - Pot-award events carry full allocation proof.
 *
 * Tests target the pure recordHandEvent helper plus the handleFoldWin and
 * handleShowdown integration so we know the lifecycle wiring writes the
 * expected event sequence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 1n, bigBlind: 2n }),
}));
vi.mock('../../src/services/poker/handEvaluator', () => ({
  evaluateHand: (hole: any[], _board: any) => {
    const strength = Array.isArray(hole) && hole[0]?.strength ? hole[0].strength : 0;
    return { rank: strength, description: 'mocked', cards: [], strength };
  },
  compareHands: (a: any, b: any) => (a.strength ?? 0) - (b.strength ?? 0),
}));
vi.mock('../../src/services/sidePots', () => ({
  calculateSidePots: vi.fn(async (_tx: any, _handId: string, players: any[]) => {
    const eligible = players
      .filter((p) => p.position !== 'folded' && p.position !== 'eliminated')
      .map((p) => p.userId);
    return [{ potNumber: 1, amount: 200n, eligiblePlayerIds: eligible }];
  }),
  storeSidePots: vi.fn(async () => {}),
  getSidePots: vi.fn(async () => []),
}));

interface LedgerRow {
  gameId: string;
  handId: string | null;
  userId: string | null;
  sequenceNumber: number;
  eventType: string;
  payload: string;
  correlationId: string | null;
}

function buildLedgerTx(initial?: { handEvents?: LedgerRow[] }) {
  const events: LedgerRow[] = (initial?.handEvents ?? []).slice();
  const tx: any = {
    handEvent: {
      findFirst: vi.fn(async (args: any) => {
        const w = args.where;
        const matches = events.filter(
          (e) =>
            e.gameId === w.gameId &&
            (e.handId ?? null) === (w.handId ?? null)
        );
        if (!matches.length) return null;
        if (args.orderBy?.sequenceNumber === 'desc') {
          matches.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        }
        return matches[0];
      }),
      create: vi.fn(async (args: any) => {
        const row: LedgerRow = {
          gameId: args.data.gameId,
          handId: args.data.handId ?? null,
          userId: args.data.userId ?? null,
          sequenceNumber: args.data.sequenceNumber,
          eventType: args.data.eventType,
          payload: args.data.payload,
          correlationId: args.data.correlationId ?? null,
        };
        events.push(row);
        return { id: 'he_' + events.length, sequenceNumber: row.sequenceNumber };
      }),
    },
  };
  return { tx, events };
}

describe('Phase 7 [M-05] — recordHandEvent', () => {
  let mod: typeof import('../../src/services/handLedger');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/handLedger');
  });

  it('assigns sequence numbers monotonically per (gameId, handId)', async () => {
    const { tx, events } = buildLedgerTx();
    const a = await mod.recordHandEvent(tx, {
      gameId: 'g1',
      handId: 'h1',
      eventType: 'hand_started',
      payload: {},
    });
    const b = await mod.recordHandEvent(tx, {
      gameId: 'g1',
      handId: 'h1',
      eventType: 'blinds_posted',
      payload: { role: 'small_blind' },
    });
    const c = await mod.recordHandEvent(tx, {
      gameId: 'g1',
      handId: 'h2',
      eventType: 'hand_started',
      payload: {},
    });
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(2);
    // Different hand bucket -> independent sequence.
    expect(c.sequenceNumber).toBe(1);
    expect(events.length).toBe(3);
  });

  it('game-level events (handId=null) are sequenced independently from any hand', async () => {
    const { tx } = buildLedgerTx();
    const a = await mod.recordHandEvent(tx, {
      gameId: 'g1',
      eventType: 'game_created',
      payload: {},
    });
    const b = await mod.recordHandEvent(tx, {
      gameId: 'g1',
      eventType: 'player_joined',
      payload: { seatIndex: 1 },
    });
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(2);
  });

  it('rejects unknown event types', async () => {
    const { tx } = buildLedgerTx();
    await expect(
      mod.recordHandEvent(tx, {
        gameId: 'g1',
        handId: 'h1',
        eventType: 'invented_event' as any,
        payload: {},
      })
    ).rejects.toThrow(/unknown event type/i);
  });

  it('refuses to write hole cards in a mid-hand event (action_applied)', async () => {
    const { tx } = buildLedgerTx();
    await expect(
      mod.recordHandEvent(tx, {
        gameId: 'g1',
        handId: 'h1',
        userId: 'u1',
        eventType: 'action_applied',
        payload: {
          action: 'call',
          holeCards: [{ rank: 'A', suit: 'spades' }],
        },
      })
    ).rejects.toThrow(/private cards/i);
  });

  it('refuses to write nested cards arrays in a mid-hand event', async () => {
    const { tx } = buildLedgerTx();
    await expect(
      mod.recordHandEvent(tx, {
        gameId: 'g1',
        handId: 'h1',
        eventType: 'street_advanced',
        payload: {
          some: { nested: { cards: [{ rank: 'K' }] } },
        },
      })
    ).rejects.toThrow(/private cards/i);
  });

  it('allows hole cards in showdown_evaluated (post-hand) and hand_completed', async () => {
    const { tx, events } = buildLedgerTx();
    await mod.recordHandEvent(tx, {
      gameId: 'g1',
      handId: 'h1',
      eventType: 'showdown_evaluated',
      payload: {
        evaluations: [{ userId: 'u1', holeCards: [{ rank: 'A' }] }],
      },
    });
    await mod.recordHandEvent(tx, {
      gameId: 'g1',
      handId: 'h1',
      eventType: 'hand_completed',
      payload: { winnerIds: ['u1'] },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'showdown_evaluated',
      'hand_completed',
    ]);
  });

  it('buildDeckCommitment returns a hex sha256 of the input', async () => {
    const h1 = await mod.buildDeckCommitment(JSON.stringify(['a', 'b']));
    const h2 = await mod.buildDeckCommitment(JSON.stringify(['a', 'b']));
    const h3 = await mod.buildDeckCommitment(JSON.stringify(['c']));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: handleFoldWin / handleShowdown emit ledger events
// ---------------------------------------------------------------------------

function buildLifecycleTx(initial: {
  players: any[];
  game: any;
  hand: any;
}) {
  const players = initial.players.map((p) => ({ ...p }));
  const balances = new Map<string, bigint>(
    initial.players.map((p) => [p.userId, 0n])
  );
  const events: LedgerRow[] = [];

  const tx: any = {
    gamePlayer: {
      findMany: vi.fn(async () =>
        players
          .slice()
          .sort((a, b) => a.seatIndex - b.seatIndex)
          .map((p) => ({ ...p, user: { id: p.userId, username: p.userId } }))
      ),
      update: vi.fn(async (args: any) => {
        const idx = players.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error('player not found');
        const data = args.data;
        if (data.chipStack != null) {
          if (typeof data.chipStack === 'object' && data.chipStack.increment != null) {
            players[idx].chipStack += BigInt(data.chipStack.increment);
          } else {
            players[idx].chipStack = BigInt(data.chipStack);
          }
        }
        if (typeof data.position === 'string') players[idx].position = data.position;
        return players[idx];
      }),
    },
    chipBalance: {
      findUnique: vi.fn(async (args: any) => {
        const userId = args.where.userId;
        if (!balances.has(userId)) return null;
        return { userId, chips: balances.get(userId)! };
      }),
      update: vi.fn(async (args: any) => {
        const userId = args.where.userId;
        const before = balances.get(userId) ?? 0n;
        balances.set(userId, before + BigInt(args.data.chips.increment));
        return { userId, chips: balances.get(userId)! };
      }),
    },
    chipAudit: { create: vi.fn(async (args: any) => args.data) },
    hand: {
      update: vi.fn(async (args: any) => args.data),
    },
    game: {
      update: vi.fn(async (args: any) => args.data),
    },
    sidePot: {
      update: vi.fn(async (args: any) => args.data),
    },
    handEvent: {
      findFirst: vi.fn(async (args: any) => {
        const w = args.where;
        const matches = events.filter(
          (e) =>
            e.gameId === w.gameId &&
            (e.handId ?? null) === (w.handId ?? null)
        );
        if (!matches.length) return null;
        matches.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        return matches[0];
      }),
      create: vi.fn(async (args: any) => {
        events.push({
          gameId: args.data.gameId,
          handId: args.data.handId ?? null,
          userId: args.data.userId ?? null,
          sequenceNumber: args.data.sequenceNumber,
          eventType: args.data.eventType,
          payload: args.data.payload,
          correlationId: args.data.correlationId ?? null,
        });
        return { id: 'he_' + events.length, sequenceNumber: args.data.sequenceNumber };
      }),
    },
  };

  return { tx, events, players, balances };
}

describe('Phase 7 [M-05] — fold-win lifecycle ledger', () => {
  let mod: typeof import('../../src/services/pokerActions');
  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  it('emits pot_awarded then hand_completed (and then game_completed if applicable)', async () => {
    const harness = buildLifecycleTx({
      game: { id: 'g1', name: 't', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      hand: { id: 'h1', pot: 200n },
      players: [
        {
          id: 'gp_alice',
          userId: 'u_alice',
          seatIndex: 0,
          chipStack: 0n,
          position: 'active',
        },
        {
          id: 'gp_bob',
          userId: 'u_bob',
          seatIndex: 1,
          chipStack: 0n,
          position: 'folded',
        },
      ],
    });

    await mod.handleFoldWin(
      harness.tx as any,
      { id: 'g1', name: 't', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      { id: 'h1', pot: 200n },
      harness.players[0]
    );

    const types = harness.events.map((e) => e.eventType);
    expect(types).toContain('pot_awarded');
    expect(types).toContain('hand_completed');
    expect(types.indexOf('pot_awarded')).toBeLessThan(types.indexOf('hand_completed'));

    // pot_awarded payload carries the proof.
    const award = harness.events.find((e) => e.eventType === 'pot_awarded')!;
    const payload = JSON.parse(award.payload);
    expect(payload.amount).toBe('200');
    expect(payload.winnerIds).toEqual(['u_alice']);
    expect(payload.shareEach).toBe('200');
    expect(payload.remainder).toBe('0');
  });
});

describe('Phase 7 [M-05] — showdown lifecycle ledger', () => {
  let mod: typeof import('../../src/services/pokerActions');
  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/pokerActions');
  });

  it('emits side_pots_built, showdown_evaluated, pot_awarded, hand_completed in order', async () => {
    const aliceHole = JSON.stringify([{ strength: 1 }]);
    const bobHole = JSON.stringify([{ strength: 2 }]);
    const harness = buildLifecycleTx({
      game: { id: 'g1', name: 't', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      hand: { id: 'h1', pot: 200n, board: '[]' },
      players: [
        {
          id: 'gp_alice',
          userId: 'u_alice',
          seatIndex: 0,
          chipStack: 0n,
          position: 'active',
          holeCards: aliceHole,
        },
        {
          id: 'gp_bob',
          userId: 'u_bob',
          seatIndex: 1,
          chipStack: 0n,
          position: 'active',
          holeCards: bobHole,
        },
      ],
    });

    await mod.handleShowdown(
      harness.tx as any,
      { id: 'g1', name: 't', dealerIndex: 0, blindLevel: 1, handsAtLevel: 0 },
      { id: 'h1', pot: 200n, board: '[]' }
    );

    const types = harness.events.map((e) => e.eventType);
    const required = [
      'side_pots_built',
      'showdown_evaluated',
      'pot_awarded',
      'hand_completed',
    ];
    for (const t of required) expect(types).toContain(t);
    // Ordering: side_pots_built < showdown_evaluated < pot_awarded < hand_completed
    let last = -1;
    for (const t of required) {
      const idx = types.indexOf(t);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }

    // Sequence numbers strictly increasing within (g1, h1).
    const handBucket = harness.events.filter((e) => e.handId === 'h1');
    for (let i = 1; i < handBucket.length; i++) {
      expect(handBucket[i].sequenceNumber).toBe(handBucket[i - 1].sequenceNumber + 1);
    }
  });
});
