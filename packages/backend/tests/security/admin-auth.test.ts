/**
 * Anti-cheat phase 2 — admin endpoint authentication (audit-30 P3 / H-01).
 *
 * Gerald audit-30 priority #3 / H-01 finding:
 * Admin secret previously travelled via query string (e.g.
 * `/refund-log?secret=...`, `/logs?secret=...`, `/bots?secret=...`).
 * Query strings leak via browser history, reverse-proxy logs, support
 * screenshots, referrer headers — a real exposure risk for a
 * real-money product.
 *
 * Fix (audit-30):
 *   - Preferred: `X-Admin-Secret` request header.
 *   - Legacy body/query secret still accepted with a deprecation
 *     warning, so existing tooling keeps working through the
 *     transition.
 *   - Empty / wrong / missing secret -> 403.
 *
 * Coverage:
 *   1. Each admin endpoint rejects 403 when no secret supplied
 *   2. Each admin endpoint rejects 403 with WRONG secret
 *   3. Header-based admin auth works (preferred path)
 *   4. Legacy body-based admin auth still works (deprecated)
 *   5. Legacy query-based admin auth still works (deprecated)
 *   6. Empty/whitespace secret rejected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const TEST_ADMIN_SECRET =
  'unit-test-admin-secret-32-chars-min-A1B2C3D4E5F6G7H8';

// Build a minimal Fastify with just the admin route mounted + the
// dependencies it needs mocked.
async function buildAdminApp(): Promise<FastifyInstance> {
  vi.doMock('../../src/db/client', () => ({
    prisma: {
      game: { findUnique: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      chipBalance: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      chipAudit: { create: vi.fn(), findMany: vi.fn(async () => []) },
      appLog: { findMany: vi.fn(async () => []) },
    },
  }));
  vi.doMock('../../src/config', () => ({
    CONFIG: {
      NODE_ENV: 'test',
      PORT: 3000,
      ADMIN_SECRET: TEST_ADMIN_SECRET,
      JWT_SECRET: 'test-secret',
    },
  }));
  vi.doMock('../../src/middleware/auth', () => ({
    authMiddleware: async () => undefined,
  }));
  vi.doMock('../../src/services/admin', () => ({
    cleanupStuckGames: vi.fn(async () => ({
      gamesMarkedCancelled: 0,
      chipsRefunded: '0',
      playersRefunded: 0,
    })),
    cancelGame: vi.fn(async () => ({
      success: true,
      playersRefunded: 0,
      totalRefunded: '0',
    })),
  }));
  const { default: adminRoutes } = await import('../../src/api/admin/index');
  const app = Fastify({ logger: false });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  return app;
}

describe('Anti-cheat phase 2 — admin endpoint authentication (audit-30 H-01)', () => {
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

  // ─── 1. No secret -> 403 on each endpoint ──────────────────────
  it.each([
    { method: 'POST' as const, url: '/api/admin/cleanup-games', body: {} },
    {
      method: 'POST' as const,
      url: '/api/admin/cancel-game',
      body: { gameId: 'g1', reason: 'test' },
    },
    { method: 'GET' as const, url: '/api/admin/refund-log' },
    { method: 'GET' as const, url: '/api/admin/logs' },
    { method: 'GET' as const, url: '/api/admin/bots' },
    {
      method: 'POST' as const,
      url: '/api/admin/kill-bots',
      body: { gameId: 'g1' },
    },
  ])('$method $url rejects (403) with NO secret', async ({ method, url, body }) => {
    app = await buildAdminApp();
    const res = await app.inject({
      method,
      url,
      ...(body ? { payload: body, headers: { 'content-type': 'application/json' } } : {}),
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── 2. Wrong secret -> 403 ────────────────────────────────────
  it('rejects WRONG admin secret via header (403)', async () => {
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/cleanup-games',
      headers: {
        'x-admin-secret': 'wrong-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects WRONG admin secret via body (403)', async () => {
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/cleanup-games',
      headers: { 'content-type': 'application/json' },
      payload: { secret: 'wrong-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects WRONG admin secret via query (403)', async () => {
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'GET',
      url:
        '/api/admin/logs?secret=wrong-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── 3. Header-based auth WORKS (preferred) ────────────────────
  it('accepts admin secret via X-Admin-Secret header', async () => {
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/cleanup-games',
      headers: {
        'x-admin-secret': TEST_ADMIN_SECRET,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  // ─── 4. Legacy body-based auth still works ────────────────────
  it('still accepts admin secret via body (legacy, deprecated)', async () => {
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/cleanup-games',
      headers: { 'content-type': 'application/json' },
      payload: { secret: TEST_ADMIN_SECRET },
    });
    expect(res.statusCode).toBe(200);
  });

  // ─── 5. Legacy query-based auth still works ───────────────────
  it('audit-31 H-02: REJECTS admin secret via query string (403)', async () => {
    // Even with the CORRECT secret value, query-string transport is
    // no longer accepted. The caller must use X-Admin-Secret header.
    // Audit-31 H-02 tightening on Gerald's call.
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/logs?secret=${encodeURIComponent(TEST_ADMIN_SECRET)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('audit-31 H-02: query secret IGNORED but valid header still works', async () => {
    // Sanity: a request that has BOTH a query secret (now ignored) AND
    // the proper header should still authenticate via the header.
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/logs?secret=${encodeURIComponent(TEST_ADMIN_SECRET)}`,
      headers: { 'x-admin-secret': TEST_ADMIN_SECRET },
    });
    expect(res.statusCode).toBe(200);
  });

  // ─── 6. Empty / whitespace secret rejected ────────────────────
  it('rejects empty admin secret via header (403)', async () => {
    app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/cleanup-games',
      headers: {
        'x-admin-secret': '',
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── 7. Header takes precedence over body ─────────────────────
  // If header is present and valid, body secret (even wrong) is
  // irrelevant. If header is wrong, request is rejected even if
  // body has the right secret (header wins).
  it('header takes precedence over body when both present', async () => {
    app = await buildAdminApp();

    // Header valid, body wrong -> still accepted (header wins).
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/admin/cleanup-games',
      headers: {
        'x-admin-secret': TEST_ADMIN_SECRET,
        'content-type': 'application/json',
      },
      payload: { secret: 'wrong-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(r1.statusCode).toBe(200);
  });
});
