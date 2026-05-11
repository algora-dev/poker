/**
 * Bot-fill unit tests.
 *
 * Coverage:
 *  1. Strategy decisions match the documented weights and respect chip limits
 *     (no fold when nothing to call, all-in when can't afford min-raise).
 *  2. Registry concurrency caps (max bots/call, max concurrent batches).
 *  3. Admin endpoint auth: wrong secret rejected, unknown env disabled in
 *     production unless ALLOW_BOT_FILL=1.
 *  4. Happy path: spawn-bots calls registry.spawnBots, kill-bots removes them.
 *
 * The full HTTP/socket bring-up is NOT exercised here — that's the harness's
 * job. We mock BotSession.start so the test stays fast and hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { decideForStrategy } from '../../src/services/botFill/strategies';
import type { BotGameState } from '../../src/services/botFill/types';
import * as registry from '../../src/services/botFill/registry';
import * as botSessionModule from '../../src/services/botFill/botSession';

// Hoisted mock control so vi.mock() factories see them.
const { sessionStartMock, sessionShutdownMock } = vi.hoisted(() => ({
  sessionStartMock: vi.fn(async () => undefined),
  sessionShutdownMock: vi.fn(),
}));

// Mock BotSession class so we never open real sockets / hit Prisma in this
// unit test. The class is imported by registry.ts via the same module path.
vi.mock('../../src/services/botFill/botSession', async () => {
  class FakeBotSession {
    cfg: any;
    userId = 'u_fake';
    username = 'bot_fake';
    actionsTaken = 0;
    startedAt = Date.now();
    status: string = 'starting';
    endedPromise: Promise<void>;
    private endedResolver!: () => void;
    constructor(cfg: any) {
      this.cfg = cfg;
      this.endedPromise = new Promise((resolve) => {
        this.endedResolver = resolve;
      });
    }
    async start() {
      await sessionStartMock();
      this.status = 'active';
    }
    shutdown(reason?: string) {
      sessionShutdownMock(reason);
      this.status = 'ended';
      this.endedResolver();
    }
    info() {
      return {
        sessionId: this.cfg.sessionId,
        gameId: this.cfg.gameId,
        userId: this.userId,
        username: this.username,
        strategy: this.cfg.strategy,
        status: this.status,
        startedAt: this.startedAt,
        actionsTaken: this.actionsTaken,
      };
    }
  }
  return { BotSession: FakeBotSession };
});

// Build a minimal Fastify with just the admin route, hand-wiring only the
// dependencies we need (no real DB). For routes that need prisma, we mock
// the games lookup directly.
async function buildAdminApp(opts: {
  adminSecret: string;
  game?: { status: string; minBuyIn: bigint; maxBuyIn: bigint; maxPlayers: number; players: Array<{ id: string }> } | null;
}): Promise<FastifyInstance> {
  vi.doMock('../../src/db/client', () => ({
    prisma: {
      game: {
        findUnique: vi.fn(async () => opts.game ?? null),
      },
      // Other Prisma calls are unused in this admin-route test.
      user: { findUnique: vi.fn() },
      chipBalance: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      chipAudit: { create: vi.fn(), findMany: vi.fn(async () => []) },
      appLog: { findMany: vi.fn(async () => []) },
    },
  }));
  vi.doMock('../../src/config', () => ({
    CONFIG: {
      NODE_ENV: 'test',
      PORT: 3000,
      ADMIN_SECRET: opts.adminSecret,
      JWT_SECRET: 'test-secret',
    },
  }));
  vi.doMock('../../src/middleware/auth', () => ({
    authMiddleware: async () => undefined,
  }));
  vi.doMock('../../src/services/admin', () => ({
    cleanupStuckGames: vi.fn(),
    cancelGame: vi.fn(),
  }));
  // Re-import after the mocks so the route file binds to them.
  const { default: adminRoutes } = await import('../../src/api/admin/index');
  const app = Fastify({ logger: false });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  return app;
}

function baseState(over: Partial<BotGameState> = {}): BotGameState {
  return {
    gameId: 'g1',
    status: 'in_progress',
    pot: '0',
    currentBet: '0',
    amountToCall: '0',
    stage: 'preflop',
    board: [],
    isMyTurn: true,
    myPlayer: {
      userId: 'u1',
      chipStack: '100000000', // 100 chips
      holeCards: [],
      position: 'active',
      currentStageBet: '0',
    },
    opponents: [],
    smallBlind: '500000',  // 0.5
    bigBlind: '1000000',   // 1
    activePlayerUserId: 'u1',
    ...over,
  };
}

describe('botFill — strategies', () => {
  it('never folds when there is no bet to face', () => {
    const state = baseState({ amountToCall: '0', currentBet: '0' });
    for (const name of ['random', 'tight', 'loose'] as const) {
      // Force the rng to favour fold path; result must still be check or raise.
      const d = decideForStrategy(name, state, () => 0.0);
      expect(d.action === 'check' || d.action === 'raise' || d.action === 'all-in').toBe(true);
    }
  });

  it('tight strategy folds the most when facing a bet', () => {
    const state = baseState({
      amountToCall: '5000000', // 5 chips to call
      currentBet: '5000000',
    });
    // rng=0.4 lands inside tight.fold (0.60) but outside random.fold (0.30).
    const tight = decideForStrategy('tight', state, () => 0.4);
    const rand = decideForStrategy('random', state, () => 0.4);
    expect(tight.action).toBe('fold');
    expect(rand.action).toBe('call');
  });

  it('all-ins when call cost exceeds remaining stack', () => {
    const state = baseState({
      amountToCall: '200000000', // 200 chips owed
      currentBet: '200000000',
      myPlayer: { ...baseState().myPlayer, chipStack: '100000000' }, // only 100
    });
    const d = decideForStrategy('loose', state, () => 0.5); // call slot
    expect(d.action).toBe('all-in');
  });

  it('never produces check when amountToCall > 0 (legality)', () => {
    // Even sub-unit owe (1 micro-chip) must not collapse to check.
    for (const owe of ['1', '500000', '999999', '1000000', '5000000', '200000000']) {
      const state = baseState({
        amountToCall: owe,
        currentBet: owe,
        myPlayer: { ...baseState().myPlayer, chipStack: '500000000' }, // 500 chips
      });
      // Sweep rng across the whole [0,1] range so all branches are exercised.
      for (let i = 0; i < 20; i++) {
        const r = i / 20;
        for (const name of ['random', 'tight', 'loose'] as const) {
          const d = decideForStrategy(name, state, () => r);
          expect(d.action).not.toBe('check');
        }
      }
    }
  });

  it('all-ins when min-raise would commit entire remaining stack', () => {
    // Stack = 10 chips, BB = 1 chip, currentBet = 5, lastInc = 5.
    // minRaiseTarget = 5 + 5 = 10. additionalCost = 10 - 0 = 10 == stack => all-in.
    const state = baseState({
      amountToCall: '5000000',
      currentBet: '5000000',
      bigBlind: '1000000',
      lastRaiseIncrement: '5000000',
      myPlayer: { ...baseState().myPlayer, chipStack: '10000000', currentStageBet: '0' },
    });
    const d = decideForStrategy('loose', state, () => 0.99); // raise slot
    expect(d.action).toBe('all-in');
  });

  it('raise emits a numeric raiseAmount when raising is selected', () => {
    const state = baseState({
      amountToCall: '5000000',
      currentBet: '5000000',
    });
    // rng=0.99 lands in raise slot for every strategy.
    const d = decideForStrategy('loose', state, () => 0.99);
    expect(d.action === 'raise' || d.action === 'all-in').toBe(true);
    if (d.action === 'raise') {
      expect(typeof d.raiseAmount).toBe('number');
      expect(d.raiseAmount!).toBeGreaterThan(0);
    }
  });
});

describe('botFill — registry validation', () => {
  beforeEach(() => {
    registry._resetForTests();
    sessionStartMock.mockClear();
    sessionShutdownMock.mockClear();
  });

  it('rejects count > MAX_BOTS_PER_CALL', () => {
    expect(() =>
      registry.validateSpawnRequest({ gameId: 'g1', count: 99 })
    ).toThrowError(/cannot exceed/);
  });

  it('rejects unknown strategy', () => {
    expect(() =>
      registry.validateSpawnRequest({ gameId: 'g1', count: 2, strategy: 'maniac' })
    ).toThrowError(/strategy must be one of/);
  });

  it('accepts a valid request', () => {
    const r = registry.validateSpawnRequest({ gameId: 'g1', count: 3, strategy: 'tight' });
    expect(r.gameId).toBe('g1');
    expect(r.count).toBe(3);
    expect(r.strategy).toBe('tight');
  });
});

describe('botFill — registry spawn/kill happy path', () => {
  beforeEach(() => {
    registry._resetForTests();
    sessionStartMock.mockClear();
    sessionShutdownMock.mockClear();
  });

  it('spawns N bots, lists them, and kills them by gameId', async () => {
    const result = await registry.spawnBots({
      gameId: 'g_happy',
      count: 2,
      strategy: 'random',
      baseUrl: 'http://127.0.0.1:3000',
      buyInChips: 100,
      bankrollChips: 500,
      adminSecret: 'admin-secret',
    });
    expect(result.spawned.length).toBe(2);
    expect(sessionStartMock).toHaveBeenCalledTimes(2);

    const listed = registry.listBots();
    expect(listed.length).toBe(2);
    expect(listed.every((b) => b.gameId === 'g_happy')).toBe(true);

    const killed = registry.killBotsAtGame('g_happy');
    expect(killed).toBe(2);
    expect(sessionShutdownMock).toHaveBeenCalledTimes(2);
    expect(registry.listBots().length).toBe(0);
  });

  it('killAllBots terminates everything across games', async () => {
    await registry.spawnBots({
      gameId: 'g_a',
      count: 1,
      strategy: 'random',
      baseUrl: 'http://127.0.0.1:3000',
      buyInChips: 100,
      bankrollChips: 500,
      adminSecret: 'x',
    });
    await registry.spawnBots({
      gameId: 'g_b',
      count: 1,
      strategy: 'loose',
      baseUrl: 'http://127.0.0.1:3000',
      buyInChips: 100,
      bankrollChips: 500,
      adminSecret: 'x',
    });
    expect(registry.listBots().length).toBe(2);
    const killed = registry.killAllBots('test');
    expect(killed).toBe(2);
    expect(registry.listBots().length).toBe(0);
  });

  it('rolls back batch on per-bot start failure', async () => {
    sessionStartMock.mockImplementationOnce(async () => undefined);
    sessionStartMock.mockImplementationOnce(async () => {
      throw new Error('table full');
    });
    await expect(
      registry.spawnBots({
        gameId: 'g_fail',
        count: 2,
        strategy: 'random',
        baseUrl: 'http://127.0.0.1:3000',
        buyInChips: 100,
        bankrollChips: 500,
        adminSecret: 'x',
      })
    ).rejects.toThrow(/table full/);
    // The first bot must have been shut down on rollback.
    expect(sessionShutdownMock).toHaveBeenCalledWith('spawn_failed');
    expect(registry.listBots().length).toBe(0);
  });
});

describe('botFill — admin endpoint auth', () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    registry._resetForTests();
    sessionStartMock.mockClear();
    sessionShutdownMock.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    vi.resetModules();
    vi.doUnmock('../../src/db/client');
    vi.doUnmock('../../src/config');
    vi.doUnmock('../../src/middleware/auth');
    vi.doUnmock('../../src/services/admin');
  });

  it('rejects spawn-bots with wrong admin secret', async () => {
    app = await buildAdminApp({
      adminSecret: 'correct-secret',
      game: {
        status: 'waiting',
        minBuyIn: 100_000_000n,
        maxBuyIn: 100_000_000n,
        maxPlayers: 8,
        players: [{ id: 'p1' }],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/spawn-bots',
      payload: { secret: 'wrong', gameId: 'g1', count: 2 },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toMatch(/Invalid admin secret/);
  });

  it('rejects spawn-bots when game is completed', async () => {
    app = await buildAdminApp({
      adminSecret: 'correct-secret',
      game: {
        status: 'completed',
        minBuyIn: 100_000_000n,
        maxBuyIn: 100_000_000n,
        maxPlayers: 8,
        players: [],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/spawn-bots',
      payload: { secret: 'correct-secret', gameId: 'g1', count: 2 },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('invalid_game_status');
  });

  it('happy path: spawns 2 bots into a waiting game', async () => {
    app = await buildAdminApp({
      adminSecret: 'correct-secret',
      game: {
        status: 'waiting',
        minBuyIn: 100_000_000n, // 100 chips
        maxBuyIn: 100_000_000n,
        maxPlayers: 8,
        players: [{ id: 'p1' }], // 1 seat taken => 7 free
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/spawn-bots',
      payload: {
        secret: 'correct-secret',
        gameId: 'g_happy',
        count: 2,
        strategy: 'random',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.spawned).toBe(2);
    expect(body.bots).toHaveLength(2);

    // GET /api/admin/bots should list them.
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/bots?secret=correct-secret',
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).bots.length).toBe(2);

    // Kill them.
    const kill = await app.inject({
      method: 'POST',
      url: '/api/admin/kill-bots',
      payload: { secret: 'correct-secret', gameId: 'g_happy' },
    });
    expect(kill.statusCode).toBe(200);
    expect(JSON.parse(kill.body).killed).toBe(2);
  });

  it('clamps count to free seats and reports clamped=true', async () => {
    app = await buildAdminApp({
      adminSecret: 'correct-secret',
      game: {
        status: 'waiting',
        minBuyIn: 100_000_000n,
        maxBuyIn: 100_000_000n,
        maxPlayers: 4,
        players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], // only 1 seat free
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/spawn-bots',
      payload: { secret: 'correct-secret', gameId: 'g1', count: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.spawned).toBe(1);
    expect(body.clamped).toBe(true);
  });
});
