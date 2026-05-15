/**
 * Anti-cheat phase 2 — JWT authentication red-team suite (audit-30).
 *
 * These tests exercise the auth middleware adversarially. For each
 * attack class we mount a tiny Fastify app with just the auth middleware
 * + a single protected echo route, then inject crafted requests.
 *
 * Coverage (Gerald audit-30 priority):
 *   1. Missing token              -> 401
 *   2. Malformed token            -> 401
 *   3. Wrong-secret token         -> 401
 *   4. Expired token              -> 401
 *   5. Valid-shape but unknown userId (no User row) -> 401
 *   6. Body-supplied userId is IGNORED — `request.user.id` comes from
 *      the verified JWT, never from the request payload. (Attacker
 *      cannot impersonate by injecting `userId` in body.)
 *   7. Tampered payload (signature mismatch after manual edit) -> 401
 *
 * Updated 2026-05-15 (audit-31 H-01, Gerald-flagged): tokens MUST
 * include `tokenType: 'access'` to authenticate protected routes.
 * Refresh tokens and legacy no-claim tokens are rejected with 401.
 * Several tests below now include the claim. Two new tests at the
 * bottom prove the strict enforcement (refresh + missing both 401).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwtPlugin from '@fastify/jwt';

const TEST_SECRET = 'unit-test-jwt-secret-do-not-use-in-production-AAAAAAAA';
const WRONG_SECRET = 'wrong-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ─── Per-test app builder ─────────────────────────────────────────────
//
// Builds a minimal Fastify app that mounts:
//   - @fastify/jwt with TEST_SECRET
//   - the project's real authMiddleware
//   - a single GET /protected echo route that returns request.user.id
//
// The middleware will call getUserById() to resolve the user record.
// We mock that with a per-test stub so we can test the "valid token but
// user record missing" case independently from the JWT verification.

async function buildAuthApp(opts: {
  getUserByIdStub: (userId: string) => Promise<any>;
}): Promise<FastifyInstance> {
  vi.doMock('../../src/services/auth', () => ({
    getUserById: vi.fn(opts.getUserByIdStub),
  }));

  // Re-import the middleware AFTER the stub is in place so it binds
  // to the mocked getUserById.
  vi.resetModules();
  const { authMiddleware } = await import('../../src/middleware/auth');

  const app = Fastify({ logger: false });
  await app.register(jwtPlugin, { secret: TEST_SECRET });

  app.get(
    '/protected',
    { preHandler: authMiddleware },
    async (request) => {
      // Echoes the authenticated user id. If the body contained a
      // userId field, it is IGNORED — request.user.id is what matters.
      return { id: (request.user as any)?.id ?? null };
    }
  );

  // A second route that accepts a body, used to verify that body.userId
  // is ignored. We only mount it for the impersonation test.
  app.post(
    '/protected-echo',
    { preHandler: authMiddleware },
    async (request) => {
      const body: any = request.body;
      return {
        authenticatedAs: (request.user as any)?.id ?? null,
        bodyClaimedUserId: body?.userId ?? null,
      };
    }
  );

  return app;
}

// Convenience: sign a JWT with the project's real secret (or a wrong one
// for negative tests). Uses a bare jsonwebtoken-equivalent via the
// @fastify/jwt plugin so the signed shape matches production.
async function signWith(secret: string, payload: any, opts: { expiresIn?: string } = {}) {
  const tmpApp = Fastify({ logger: false });
  await tmpApp.register(jwtPlugin, { secret });
  const token = tmpApp.jwt.sign(payload, opts.expiresIn ? { expiresIn: opts.expiresIn } : {});
  await tmpApp.close();
  return token;
}

describe('Anti-cheat phase 2 — JWT authentication (audit-30)', () => {
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

  // ─────────────────────────────────────────────────────────────────
  // 1. Missing token
  // ─────────────────────────────────────────────────────────────────
  it('rejects request with NO Authorization header (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async () => ({ id: 'u1', email: 'u1@x', username: 'u1' }),
    });
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Malformed token
  // ─────────────────────────────────────────────────────────────────
  it('rejects request with malformed Authorization header (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async () => ({ id: 'u1', email: 'u1@x', username: 'u1' }),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  // SECURITY [audit-31 H-01]: a happy-path access token still works.
  // This is the baseline that the new tokenType requirement permits.
  it('accepts a properly-signed access token (200)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async (userId: string) => ({
        id: userId,
        email: `${userId}@x`,
        username: userId,
      }),
    });
    const token = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'access',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'u1' });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Wrong-secret token
  // ─────────────────────────────────────────────────────────────────
  it('rejects token signed with the WRONG secret (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async () => ({ id: 'u1', email: 'u1@x', username: 'u1' }),
    });
    const forged = await signWith(WRONG_SECRET, {
      userId: 'u1',
      tokenType: 'access',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Expired token
  // ─────────────────────────────────────────────────────────────────
  it('rejects an expired token (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async () => ({ id: 'u1', email: 'u1@x', username: 'u1' }),
    });
    // Manufacture an expired token by embedding `exp` directly in the
    // payload (JWT spec: exp is a unix-second timestamp). @fastify/jwt's
    // `expiresIn` option requires a POSITIVE duration, so we set `exp`
    // manually to a value 60 seconds in the past.
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'access',
      iat: nowSec - 120,
      exp: nowSec - 60,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Valid shape but unknown userId (no User row)
  // ─────────────────────────────────────────────────────────────────
  it('rejects a valid token whose userId does not resolve to a User row (401)', async () => {
    app = await buildAuthApp({
      // Stub getUserById returns null for any userId.
      getUserByIdStub: async () => null,
    });
    const token = await signWith(TEST_SECRET, {
      userId: 'u_ghost',
      tokenType: 'access',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Body-supplied userId is IGNORED
  //
  // Attacker sends a valid JWT for Alice, but tries to slip Bob's
  // userId into the request body. The route handler must see
  // request.user.id = 'alice' regardless of body content.
  // ─────────────────────────────────────────────────────────────────
  it('IGNORES body-supplied userId (cannot impersonate via payload)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async (userId: string) => ({
        id: userId,
        email: `${userId}@x`,
        username: userId,
      }),
    });
    const aliceToken = await signWith(TEST_SECRET, {
      userId: 'alice',
      tokenType: 'access',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/protected-echo',
      headers: {
        authorization: `Bearer ${aliceToken}`,
        'content-type': 'application/json',
      },
      payload: { userId: 'bob' }, // attacker injects Bob's id
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authenticatedAs).toBe('alice'); // server-derived
    expect(body.bodyClaimedUserId).toBe('bob'); // echoed for sanity
    // The two MUST differ — proves the body claim is informational only.
    expect(body.authenticatedAs).not.toBe(body.bodyClaimedUserId);
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. Tampered payload (signature mismatch after manual edit)
  //
  // Take a valid token, mutate the payload section (middle of the JWT)
  // by appending a character. The signature is now invalid for the
  // edited header.payload, so @fastify/jwt rejects it.
  // ─────────────────────────────────────────────────────────────────
  it('rejects a token whose payload has been tampered with (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async () => ({ id: 'u1', email: 'u1@x', username: 'u1' }),
    });
    const valid = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'access',
    });
    const [header, payload, sig] = valid.split('.');
    // Decode + re-encode payload with an injected admin flag.
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    decoded.admin = true;
    decoded.userId = 'attacker-injected-id';
    const tamperedPayload = Buffer.from(JSON.stringify(decoded), 'utf8')
      .toString('base64url')
      .replace(/=+$/, '');
    const tampered = `${header}.${tamperedPayload}.${sig}`;
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ───────────────────────────────────────────────
  // SECURITY [audit-31 H-01]: tokenType enforcement on protected routes.
  //
  // After audit-31, authMiddleware REQUIRES `tokenType: 'access'`.
  // Refresh tokens and legacy no-claim tokens cannot be used to call
  // protected HTTP routes. These tests prove that.
  // ────────────────────────────────────────────────

  it('audit-31 H-01: REFRESH token cannot authenticate a protected route (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async (userId: string) => ({
        id: userId,
        email: `${userId}@x`,
        username: userId,
      }),
    });
    const refresh = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'refresh',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${refresh}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('audit-31 H-01: LEGACY token without tokenType cannot authenticate (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async (userId: string) => ({
        id: userId,
        email: `${userId}@x`,
        username: userId,
      }),
    });
    // Token has a valid signature and userId, but NO tokenType claim.
    // Pre-audit-31 this was accepted with a warning; post-audit-31
    // it's rejected so the migration is clean.
    const legacy = await signWith(TEST_SECRET, { userId: 'u1' });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('audit-31 H-01: token with bogus tokenType cannot authenticate (401)', async () => {
    app = await buildAuthApp({
      getUserByIdStub: async (userId: string) => ({
        id: userId,
        email: `${userId}@x`,
        username: userId,
      }),
    });
    const weird = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'admin', // not 'access' nor 'refresh'
    });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${weird}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
