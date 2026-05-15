/**
 * Anti-cheat phase 2 — socket auth tokenType regression (audit-32).
 *
 * Gerald audit-32 narrow re-review: "I found no socket-level test
 * specifically proving a refresh token cannot connect to Socket.IO.
 * The source fix is clear, so this is not a merge blocker, but Dave
 * should add that regression test before public mainnet."
 *
 * This file lands the regression now. We don't spin up a real
 * socket.io server — instead, the socket auth module exports
 * `verifySocketToken(token)` (the pure logic that `io.use` wraps).
 * If that helper accepts the wrong token, the bug is back.
 *
 * Coverage:
 *   1. Access token with correct signature -> ok: true, userId set
 *   2. Refresh token -> ok: false, reason: wrong_token_type
 *   3. Legacy no-claim token -> ok: false, reason: wrong_token_type
 *   4. Bogus tokenType -> ok: false, reason: wrong_token_type
 *   5. Wrong-secret token -> ok: false, reason: invalid_or_expired
 *   6. Token with no userId -> ok: false, reason: invalid_payload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwtPlugin from '@fastify/jwt';

const TEST_SECRET =
  'unit-test-socket-secret-do-not-use-in-prod-AAAAAAAAA';
const WRONG_SECRET =
  'wrong-socket-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Mock the config BEFORE the socket module loads, so verifyJwt
// (created at module-init time) uses TEST_SECRET.
vi.mock('../../src/config', () => ({
  CONFIG: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    PORT: 3000,
    CORS_ORIGINS: '',
  },
}));
vi.mock('../../src/db/client', () => ({
  prisma: {
    gamePlayer: { findFirst: vi.fn() },
  },
}));
vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
}));

async function signWith(secret: string, payload: any): Promise<string> {
  const tmpApp = Fastify({ logger: false });
  await tmpApp.register(jwtPlugin, { secret });
  const token = tmpApp.jwt.sign(payload);
  await tmpApp.close();
  return token;
}

describe('Anti-cheat phase 2 — socket auth tokenType (audit-32)', () => {
  let verifySocketToken: (
    token: string
  ) =>
    | { ok: true; userId: string }
    | { ok: false; reason: 'invalid_payload' | 'wrong_token_type' | 'invalid_or_expired' };

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/socket');
    verifySocketToken = mod.verifySocketToken;
  });

  it('access token: accepted, userId returned', async () => {
    const tok = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'access',
    });
    const v = verifySocketToken(tok);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.userId).toBe('u1');
  });

  it('refresh token: REJECTED with wrong_token_type', async () => {
    const tok = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'refresh',
    });
    const v = verifySocketToken(tok);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('wrong_token_type');
  });

  it('legacy no-claim token: REJECTED with wrong_token_type', async () => {
    // Token has valid signature + userId but no tokenType field.
    // Pre-audit-31 it would have been accepted. Now must be rejected.
    const tok = await signWith(TEST_SECRET, { userId: 'u1' });
    const v = verifySocketToken(tok);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('wrong_token_type');
  });

  it('bogus tokenType: REJECTED with wrong_token_type', async () => {
    const tok = await signWith(TEST_SECRET, {
      userId: 'u1',
      tokenType: 'admin',
    });
    const v = verifySocketToken(tok);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('wrong_token_type');
  });

  it('wrong-secret token: REJECTED with invalid_or_expired', async () => {
    const tok = await signWith(WRONG_SECRET, {
      userId: 'u1',
      tokenType: 'access',
    });
    const v = verifySocketToken(tok);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('invalid_or_expired');
  });

  it('token with no userId: REJECTED with invalid_payload', async () => {
    const tok = await signWith(TEST_SECRET, { tokenType: 'access' });
    const v = verifySocketToken(tok);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('invalid_payload');
  });

  it('garbage string: REJECTED with invalid_or_expired', async () => {
    const v = verifySocketToken('not-a-real-jwt');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('invalid_or_expired');
  });
});
