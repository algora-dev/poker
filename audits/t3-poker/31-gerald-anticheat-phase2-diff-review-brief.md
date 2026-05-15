# Gerald — Brief: anti-cheat phase 2 diff review (audit-31)

**Date:** 2026-05-15
**Requester:** Dave
**Branch:** `anticheat-phase-2` (3 commits ahead of `main`)
**Status:** READY FOR DIFF REVIEW. Production `main` deploys are unaffected — branch is isolated, Railway + Vercel pinned to main, verified.

## Why this brief

Phase 2 implementation is complete on branch. 30 new tests added (now 221/221 total backend), 5 hardening items shipped, all 5 in your audit-30 priority order. Before I open the PR and merge to main I want your diff-review pass.

This brief summarises what's on the branch vs `v0.9-pre-anticheat` baseline. Read it alongside the actual diff: `git diff v0.9-pre-anticheat..anticheat-phase-2`.

## The 3 commits

```
e72c882 feat(security): P3 - admin header + JWT tokenType + JWT_SECRET strength + failed-action throttle + socket spam guard + tests
9a0cea5 feat(security): P2 - dead-seat reject + finite-number guard + tests
88d8726 test(security): P1 - auth-jwt + action-replay-concurrency suites
```

## What landed, in your priority order

### P1 — adversarial action tests (commit 88d8726)

**New: `tests/security/` red-team test layer.**

- **`auth-jwt.test.ts`** (7 tests). Missing / malformed / wrong-secret / expired / unknown-user / tampered-payload tokens all → 401. Plus: body-supplied `userId` is IGNORED — the route's `request.user.id` is server-derived from the verified JWT.
- **`action-replay-concurrency.test.ts`** (6 tests). N=10 and N=50 parallel identical actions → exactly 1 succeeds. Chips NOT double-debited. Version bumped exactly once. Exactly 1 `HandAction` row written. Human + turnTimer race share the same H-02 guard. Shared harness models Postgres optimistic concurrency atomically (no awaits between version-read and version-write).

### P2 — engine hardening (commit 9a0cea5)

**Engine changes in `pokerActions.ts`:**

1. **Dead-seat reject (audit-30 H-02).** After loading `player` and BEFORE the H-02 version guard:
   ```ts
   if (player.position === 'folded' || player.position === 'eliminated' || player.position === 'all_in') {
     throw new Error(`Player cannot act from current seat state: ${player.position}`);
   }
   ```
2. **Finite-number guard (audit-30 M-01).** In the same block:
   ```ts
   if (action === 'raise' && raiseAmount !== undefined && !Number.isFinite(raiseAmount)) {
     throw new Error('Invalid raise amount');
   }
   ```

**Schema change in `api/games/index.ts`:**
- `raiseAmount: z.number().optional()` → `raiseAmount: z.number().finite().optional()`. NaN / Infinity rejected at the wire boundary with a clean 400 instead of crashing on `BigInt(NaN)` later.

**New tests:**
- **`seat-state-actions.test.ts`** (14 tests). Folded/eliminated/all_in player attempts each of fold/check/call/raise/all-in → zero mutations recorded. One test confirms reject fires BEFORE the H-02 guard.
- **`action-input-bounds.test.ts`** (13 tests). NaN/Infinity/negative/zero/micro-amount raises → rejected. Above-stack raise → CLAMPED to all-in (engine semantics, not rejected). Plus 5 Zod schema parse-test assertions.

### P3 — admin/auth/socket hardening + remaining tests (commit e72c882)

This is the biggest commit. Five hardening items + four test suites.

#### 1. Admin secret moved to header (audit-30 H-01)

`api/admin/index.ts` now has:
- `getAdminSecretFromRequest(request)` — extracts secret from `X-Admin-Secret` header first, falls back to body, then query. Returns `{ secret, legacy: 'body' | 'query' | null }`.
- `validateAdminAuth(request, route)` — combines extraction + constant-time validation, logs a deprecation warning if a legacy transport was used.

All 8 admin endpoints refactored to use `validateAdminAuth` first, then parse body for non-secret fields. Body `secret` is now optional (still parsed for backward compat).

**`services/botFill/botSession.ts`** updated to send the admin secret via header on its internal `/api/admin/add-chips` callbacks.

#### 2. JWT `tokenType` claim (audit-30 H-03)

`api/auth/index.ts`:
- signup + login: sign access tokens with `{ userId, tokenType: 'access' }` and refresh tokens with `{ userId, tokenType: 'refresh' }`.
- `/refresh`: rejects if `tokenType === 'access'`. Accepts missing `tokenType` (legacy tokens) with a deprecation warning log so existing logged-in users aren't kicked out. After 7d max refresh TTL all legacy tokens are gone and we can tighten further.

`middleware/auth.ts`:
- `JwtPayload` interface extended with optional `tokenType: 'access' | 'refresh'`.

#### 3. `JWT_SECRET` strength check at boot (audit-30 M-04)

`config.ts`: in production, `JWT_SECRET` must be ≥ 32 chars and not match a known-placeholder list. Mirror of the existing ADMIN_SECRET check. Boot-fail if violated.

#### 4. Failed-action throttle (audit-30, Gerald-flagged)

**New: `services/failedActionThrottle.ts`.** Per-(user, game) bucket. 5 rejected actions / 60s → 429 with `retryAfterMs`. Successful action clears the bucket. Process-local; sufficient for single-instance Railway deploy. Auto-GC every 5 minutes.

Wired into `api/games/index.ts` action route catch path: increment the bucket on rejection, return 429 if exceeded, otherwise return 400 with the original error.

#### 5. Socket `join:game` spam guard (audit-30 M-02)

In `socket/index.ts`:
- Per-socket: max 10 join attempts / 60s. Silent reject above that — no log write, no ack with explicit code.
- Per-(socket, gameId): rejected-join AppLog rows coalesced. At most one row per 60s for the same room. Repeated rejections to the same room → dropped from the log.

#### 6. `security_event` AppLog category (audit-30)

`services/appLogger.ts`: added `'security_event'` to the `AppLogCategory` union. Distinct from `'action'` so ops dashboards can separate adversarial rejections from honest mistakes.

Action route catch path writes a `security_event` row for every rejection with `{ reason, throttleExceeded }`.

#### Tests in this commit

- **`admin-auth.test.ts`** (14 tests). No-secret / wrong-secret rejections; header / body / query auth paths all work; empty secret rejected; header takes precedence.
- **`hole-card-leakage.test.ts`** (6 tests). `getGameState` during each stage: opponents always have empty `holeCards`, requester has theirs. Perspective check across 3 users. Non-participant gets thrown out.
- **`rng-ledger.test.ts`** (5 tests). `deck.ts` source uses `crypto.randomInt`, NEVER `Math.random` (regression guard, comments stripped before regex check). 10k-shuffle statistical sanity. `buildDeckCommitment` is sha256, deterministic, collision-free.
- **`failed-action-throttle.test.ts`** (5 tests). First 5 pass; 6th triggers; clear resets; buckets isolated.

## Test counts

- Phase 1 baseline: 191 tests
- After this branch: **221 tests** (+30 across 8 new files in `tests/security/`)
- All pass; backend tsc clean; frontend builds clean.

## Things I want your eyes on

### Critical

1. **Dead-seat reject placement.** I put it AFTER `findFirst(player)` but BEFORE the H-02 `updateMany` guard. The test confirms no `gamePlayer.update` / `handAction.create` / `hand.updateMany` runs. Confirm placement is correct.
2. **JWT tokenType transition rule.** `/refresh` accepts tokens MISSING the claim (legacy) with a warning, rejects tokens claiming `tokenType: 'access'`. Is the warning-on-missing the right transition strategy, or should we hard-reject immediately and force all users to re-login?
3. **Admin secret legacy transport.** I kept body+query as deprecated fallbacks so existing tooling (cron jobs, support scripts, the bot session before I patched it) keeps working. Acceptable for now? Or should we hard-deprecate query at minimum (query is the worst transport — logs into proxies/history) and force header for query routes?
4. **Failed-action throttle scope.** Currently keyed by `(userId, gameId)`. Should it ALSO key by IP for unauthenticated/pre-auth probing? The 401 path runs before we know `userId` though — there's no clean IP fallback in the current setup.
5. **Socket join-spam throttle: silent vs surfaced.** Above 10/min/socket the response is `{ ok: false, code: 'rate_limited' }` with no log row. Is silent the right behaviour, or should we log ONE row per socket/minute at the throttle moment? I went silent because at 10/min/socket we're past the point where honest clients live.

### Nice-to-have

6. **Hole-card leakage test breadth.** I covered HTTP `getGameState`. Should I also test that `game:state` socket pushes (per-user channel) don't leak? Same underlying function calls `getGameState`, so it's likely already covered by transitivity, but I didn't add a socket-level test.
7. **RNG statistical sanity.** I used 10k shuffles with ±40% tolerance per cell. Is that strict enough as a regression guard? I can bump to 100k with tighter tolerance if you'd like.
8. **`audit-31` is technically a review pass, not a new finding scope.** Should it close with a sign-off note, or do you want me to fold any new findings into an `audit-31` document of its own?

## What's deferred to a later phase (per your audit-30)

- Full JWT `kid` rotation + dual-key verification
- Refresh token revocation table
- Collusion / multi-account detection
- External narrow pen-test (required before public mainnet)

## Diff command for your review

```bash
cd ~/.openclaw/workspace-gerald/poker  # or wherever you have it
git fetch origin
git log v0.9-pre-anticheat..origin/anticheat-phase-2 --oneline
git diff v0.9-pre-anticheat..origin/anticheat-phase-2
```

If `v0.9-pre-anticheat` isn't fetched: `git fetch origin --tags`.

## Files most worth reading

Hardening:
- `packages/backend/src/services/pokerActions.ts` lines 65–115 — dead-seat reject + finite-number guard placement
- `packages/backend/src/api/admin/index.ts` — `getAdminSecretFromRequest` + `validateAdminAuth` helpers + every endpoint refactor
- `packages/backend/src/api/auth/index.ts` lines ~70–215 — `tokenType` claim + /refresh check
- `packages/backend/src/config.ts` — JWT_SECRET strength
- `packages/backend/src/services/failedActionThrottle.ts` — throttle module
- `packages/backend/src/socket/index.ts` lines ~115–195 — join:game spam guard
- `packages/backend/src/services/appLogger.ts` — `security_event` category

Tests:
- All 8 files in `packages/backend/tests/security/`

## Ask

1. Read the diff. Flag anything risky.
2. Answer Q1–Q5 (critical).
3. Optional answers on Q6–Q8.
4. Either sign-off → I open PR to main and merge, OR a fix list → I land it before PR.

If you want a tighter scope diff (e.g. just P3 changes), say so.

Branch: `anticheat-phase-2`. Production untouched. Playtests continue on `main`.
