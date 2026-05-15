/**
 * Anti-cheat phase 2 — /api/auth/refresh tokenType enforcement (audit-31 H-01).
 *
 * Gerald audit-31 H-01: /refresh must REQUIRE `tokenType: 'refresh'`.
 * Pre-audit-30 it accepted any valid JWT, meaning an access token
 * could refresh itself indefinitely. Audit-30 added a partial fix
 * (reject `tokenType === 'access'`, accept missing claim with warning).
 * Audit-31 tightened: missing claim ALSO rejected so the transition
 * is clean for pre-production.
 *
 * Coverage:
 *   1. Refresh token with `tokenType: 'refresh'` -> 200, new access token
 *   2. Access token (`tokenType: 'access'`) -> 401
 *   3. Legacy token without tokenType claim -> 401
 *   4. Bogus tokenType -> 401
 *   5. Returned access token has `tokenType: 'access'` claim
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwtPlugin from '@fastify/jwt';

const TEST_SECRET =
  'unit-test-jwt-secret-do-not-use-in-production-AAAAAAAA';

async function buildRefreshApp(): Promise<FastifyInstance> {
  // Mock everything the auth route needs. Only /refresh is actually
  // exercised by these tests, but route registration calls into the
  // mocked services dir at module load.
  vi.doMock('../../src/services/auth', () => ({
    createUser: vi.fn(),
    authenticateUser: vi.fn(),
    getUserById: vi.fn(async () => ({
      id: 'u1',
      email: 'u1@x',
      username: 'u1',
    })),
    linkWalletToUser: vi.fn(),
  }));
  vi.doMock('../../src/middleware/auth', () => ({
    authMiddleware: async () => undefined,
    optionalAuthMiddleware: async () => undefined,
  }));
  vi.doMock('../../src/utils/logger', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.resetModules();
  const { default: authRoutes } = await import('../../src/api/auth/index');

  const app = Fastify({ logger: false });
  await app.register(jwtPlugin, { secret: TEST_SECRET });
  await app.register(authRoutes, { prefix: '/api/auth' });
  return app;
}

async function signWith(payload: any, opts: { expiresIn?: string } = {}) {
  const tmpApp = Fastify({ logger: false });
  await tmpApp.register(jwtPlugin, { secret: TEST_SECRET });
  const token = tmpApp.jwt.sign(
    payload,
    opts.expiresIn ? { expiresIn: opts.expiresIn } : {}
  );
  await tmpApp.close();
  return token;
}

// Decode a JWT payload (no signature check — for inspection only).
function decodePayload(token: string): any {
  const [, payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
}

describe('Anti-cheat phase 2 — /refresh tokenType enforcement (audit-31 H-01)', () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('refresh token with tokenType=refresh succeeds and returns new access token', async () => {
    app = await buildRefreshApp();
    const refresh = await signWith({ userId: 'u1', tokenType: 'refresh' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${refresh}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeDefined();
    // The new access token MUST itself carry tokenType: 'access'.
    const decoded = decodePayload(body.accessToken);
    expect(decoded.userId).toBe('u1');
    expect(decoded.tokenType).toBe('access');
  });

  it('access token rejected on /refresh (401)', async () => {
    app = await buildRefreshApp();
    const access = await signWith({ userId: 'u1', tokenType: 'access' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('legacy token without tokenType rejected on /refresh (401)', async () => {
    app = await buildRefreshApp();
    const legacy = await signWith({ userId: 'u1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('bogus tokenType rejected on /refresh (401)', async () => {
    app = await buildRefreshApp();
    const weird = await signWith({ userId: 'u1', tokenType: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${weird}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('missing token rejected (401)', async () => {
    app = await buildRefreshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
    });
    expect(res.statusCode).toBe(401);
  });

  it('malformed token rejected (401)', async () => {
    app = await buildRefreshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});
