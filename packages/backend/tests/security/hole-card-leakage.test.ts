/**
 * Anti-cheat phase 2 — hole-card leakage prevention (audit-30 P3).
 *
 * Gerald audit-30: ensure `getGameState(gameId, userId)` never reveals
 * another player's hole cards. `myPlayer.holeCards` is the requesting
 * user's own cards (legitimate); `opponents[].holeCards` MUST be []
 * regardless of game stage, so HTTP state polling cannot be used to
 * sniff opponents' cards.
 *
 * Hole cards are revealed only at showdown via the `game:showdown`
 * event (which carries `players[].holeCards` for the showdown
 * participants). That path is a separate emit, not via getGameState.
 *
 * Coverage:
 *   1. Each opponent has empty holeCards regardless of game stage
 *   2. Requester's own holeCards are returned (preflop / flop / turn / river)
 *   3. A non-participating user cannot read another game's state at all
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const buildPlayer = (overrides: any = {}) => ({
  id: 'gp_default',
  userId: 'u_default',
  gameId: 'g1',
  chipStack: 100_000_000n,
  position: 'active',
  seatIndex: 0,
  holeCards: '[{"rank":"A","suit":"spades","value":14},{"rank":"K","suit":"spades","value":13}]',
  user: { id: 'u_default', username: 'u_default', avatarId: null },
  ...overrides,
});

function setupGameStateMock(opts: {
  stage: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'completed';
}) {
  const players = [
    buildPlayer({
      id: 'gp1',
      userId: 'u1',
      seatIndex: 0,
      holeCards: '[{"rank":"A","suit":"spades","value":14},{"rank":"A","suit":"hearts","value":14}]',
      user: { id: 'u1', username: 'u1', avatarId: null },
    }),
    buildPlayer({
      id: 'gp2',
      userId: 'u2',
      seatIndex: 1,
      holeCards: '[{"rank":"K","suit":"spades","value":13},{"rank":"K","suit":"hearts","value":13}]',
      user: { id: 'u2', username: 'u2', avatarId: null },
    }),
    buildPlayer({
      id: 'gp3',
      userId: 'u3',
      seatIndex: 2,
      holeCards: '[{"rank":"Q","suit":"spades","value":12},{"rank":"Q","suit":"hearts","value":12}]',
      user: { id: 'u3', username: 'u3', avatarId: null },
    }),
  ];

  const game = {
    id: 'g1',
    name: 'TestGame',
    status: 'in_progress',
    createdBy: 'u1',
    smallBlind: 1_000_000n,
    bigBlind: 2_000_000n,
    dealerIndex: 0,
    players,
  };

  const hand = {
    id: 'h1',
    gameId: 'g1',
    handNumber: 1,
    stage: opts.stage,
    pot: 6_000_000n,
    currentBet: 2_000_000n,
    activePlayerIndex: 0,
    version: 0,
    board: '[]',
    deck: '[]',
    turnStartedAt: new Date(),
    completedAt: null,
  };

  vi.doMock('../../src/db/client', () => ({
    prisma: {
      game: {
        findUnique: vi.fn(async () => ({ ...game, hands: [hand] })),
      },
      gamePlayer: {
        findFirst: vi.fn(async ({ where }: any) =>
          players.find((p) => p.userId === where.userId) ?? null
        ),
        findMany: vi.fn(async () => players),
      },
      handAction: {
        findMany: vi.fn(async () => []),
      },
      hand: {
        findUnique: vi.fn(async () => hand),
      },
    },
  }));

  return { players, game, hand };
}

describe('Anti-cheat phase 2 — hole-card leakage (audit-30)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each(['preflop', 'flop', 'turn', 'river'] as const)(
    'getGameState during %s: opponents have EMPTY holeCards, requester has theirs',
    async (stage) => {
      setupGameStateMock({ stage });
      const { getGameState } = await import('../../src/services/holdemGame');

      const stateForU1 = await getGameState('g1', 'u1');

      // Requester u1 gets their own cards.
      expect(stateForU1.myPlayer.userId).toBe('u1');
      expect(stateForU1.myPlayer.holeCards).toEqual([
        { rank: 'A', suit: 'spades', value: 14 },
        { rank: 'A', suit: 'hearts', value: 14 },
      ]);

      // Opponents (u2, u3) MUST have empty holeCards.
      expect(stateForU1.opponents).toHaveLength(2);
      for (const opp of stateForU1.opponents) {
        expect(opp.userId).not.toBe('u1');
        expect(
          opp.holeCards,
          `opponent ${opp.userId} during ${stage} must have empty holeCards, got: ${JSON.stringify(opp.holeCards)}`
        ).toEqual([]);
      }
    }
  );

  it('each user sees only their own cards (perspective check)', async () => {
    setupGameStateMock({ stage: 'flop' });
    const { getGameState } = await import('../../src/services/holdemGame');

    const stateForU1 = await getGameState('g1', 'u1');
    const stateForU2 = await getGameState('g1', 'u2');
    const stateForU3 = await getGameState('g1', 'u3');

    // u1 sees AA, no one else's cards.
    expect(stateForU1.myPlayer.holeCards).toEqual([
      { rank: 'A', suit: 'spades', value: 14 },
      { rank: 'A', suit: 'hearts', value: 14 },
    ]);
    for (const o of stateForU1.opponents) expect(o.holeCards).toEqual([]);

    // u2 sees KK.
    expect(stateForU2.myPlayer.holeCards).toEqual([
      { rank: 'K', suit: 'spades', value: 13 },
      { rank: 'K', suit: 'hearts', value: 13 },
    ]);
    for (const o of stateForU2.opponents) expect(o.holeCards).toEqual([]);

    // u3 sees QQ.
    expect(stateForU3.myPlayer.holeCards).toEqual([
      { rank: 'Q', suit: 'spades', value: 12 },
      { rank: 'Q', suit: 'hearts', value: 12 },
    ]);
    for (const o of stateForU3.opponents) expect(o.holeCards).toEqual([]);
  });

  it('a non-participating user cannot read game state at all', async () => {
    setupGameStateMock({ stage: 'flop' });
    const { getGameState } = await import('../../src/services/holdemGame');
    // u_outsider is not in the players array. gamePlayer.findFirst
    // returns null. getGameState must throw before any hole cards are
    // assembled.
    await expect(getGameState('g1', 'u_outsider')).rejects.toThrow();
  });
});
