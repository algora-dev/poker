# Audit: T3 Poker — Anti-cheat Phase 2 Diff Review
Date: 2026-05-15 | Auditor: Gerald | Scope: `v0.9-pre-anticheat..anticheat-phase-2` diff review

## Executive Summary

- **Do not merge to `main` yet.** The branch is materially stronger than `main`, but two auth/admin items leave real-money risk still open.
- **High:** refresh tokens can still be used as normal access credentials on protected HTTP routes and sockets. `/refresh` now rejects `tokenType: 'access'`, but `authMiddleware` and socket auth accept any valid JWT with `userId`.
- **High:** admin query-string secrets are still accepted. The code prefers `X-Admin-Secret`, but the dangerous path from audit-30 remains active by design.
- **Good:** dead-seat rejection placement is correct, finite-number guarding is correctly layered, concurrency/replay testing is a useful regression suite, and the failed-action throttle is directionally sound for current single-instance deploys.
- **Recommendation:** land a small fix commit before PR: require `tokenType: 'access'` for normal HTTP/socket auth, require `tokenType: 'refresh'` for `/refresh` unless Dave deliberately chooses a very short dev-only grace, and remove query-secret fallback immediately.

## Review Basis

- Repo: `C:\Users\Jimmy\.openclaw\workspace-dave\poker`
- Branch inspected: `anticheat-phase-2`
- HEAD inspected: `0b8f5d86d6589210b15b0013cca204e48ac63ef3`
- Security commits in brief present: `88d8726`, `9a0cea5`, `e72c882`; current HEAD also includes the audit-31 brief doc commit.
- Diff inspected: `git diff v0.9-pre-anticheat..anticheat-phase-2`
- Tests were **not run**: Gerald is read-only for Dave's repo; running the suite/build inside the audited project needs Shaun's explicit command approval.

## Critical Findings

None found in the changed poker engine path.

## High Findings

### [H-01] Refresh tokens still work as access tokens — Confirmed

- **Category:** Security / Auth
- **Evidence:**
  - Signup/login now correctly issue access tokens with `tokenType: 'access'` and refresh tokens with `tokenType: 'refresh'`: `packages/backend/src/api/auth/index.ts:76-83`, `packages/backend/src/api/auth/index.ts:142-149`.
  - `/refresh` rejects only `payload.tokenType === 'access'`: `packages/backend/src/api/auth/index.ts:212-217`.
  - Normal HTTP auth verifies the JWT then uses `payload.userId` without checking `tokenType`: `packages/backend/src/middleware/auth.ts:56-70`.
  - Socket auth also verifies the JWT then accepts any payload with `userId`: `packages/backend/src/socket/index.ts:85-90`.
  - The security auth test suite has no refresh/access token-type test; it still documents tokenType enforcement as “NOT YET COVERED”: `packages/backend/tests/security/auth-jwt.test.ts:19-21`. A repo-wide test search found no `/refresh` or token-type assertions outside that note.
- **Impact:** A refresh token has a 7-day TTL. If it can call protected routes or open sockets, the practical access-token lifetime remains 7 days for gameplay/admin-adjacent user actions, not 15 minutes. That weakens the whole access/refresh separation for a real-money game.
- **Remediation:**
  1. In `authMiddleware`, reject `payload.tokenType !== 'access'` for protected HTTP routes.
  2. In `optionalAuthMiddleware`, only attach a user for `tokenType === 'access'`; otherwise ignore/reject depending on route semantics.
  3. In socket auth, require `tokenType === 'access'` before setting `socket.userId`.
  4. In `/refresh`, require `tokenType === 'refresh'`.
  5. Add tests proving: refresh token cannot hit `/protected`, refresh token cannot connect socket, access token cannot refresh, refresh token can refresh.
- **Transition decision:** Because this is still dev/testnet and pre-PR, I would force re-login rather than keep a 7-day legacy hole. If Dave wants a softer transition, accept missing `tokenType` only for a short access-token grace window, not for the full refresh TTL.

### [H-02] Admin query-string secret transport remains active — Confirmed

- **Category:** Security / Admin auth
- **Evidence:**
  - `getAdminSecretFromRequest()` still falls back to `body.secret` and then `query.secret`: `packages/backend/src/api/admin/index.ts:71-79`.
  - The helper explicitly describes query as “worst case — hits server logs” but still returns it as valid auth material: `packages/backend/src/api/admin/index.ts:76-79`.
  - `validateAdminAuth()` only logs a warning for legacy transports, then returns `true`: `packages/backend/src/api/admin/index.ts:90-99`.
  - GET admin routes still use this helper, so `/refund-log`, `/logs`, and `/bots` can still authenticate via query string: `packages/backend/src/api/admin/index.ts:184-191`, `packages/backend/src/api/admin/index.ts:239-244`, `packages/backend/src/api/admin/index.ts:491-499`.
  - The new test suite locks this in as intended behaviour: “still accepts admin secret via query”: shown in `packages/backend/tests/security/admin-auth.test.ts` per diff/test inspection.
- **Impact:** Audit-30's risk is not removed, only made less likely if clients migrate. Any old script, bookmarked URL, browser history, proxy log, support screenshot, or referrer path can still leak the admin secret. For a real-money app, admin endpoints should not keep accepting the known-bad transport.
- **Remediation:**
  1. Remove `query.secret` fallback before merge.
  2. For POST routes, preferably remove `body.secret` too; if Dave needs a brief migration, body fallback is less bad than query but should be timeboxed and disabled in production.
  3. Update `admin-auth.test.ts` so query-secret requests return `403`.
  4. Keep `X-Admin-Secret` as the only production path.

## Medium Findings

### [M-01] Failed-action throttle is process-local and only keyed by `(userId, gameId)` — Likely / accepted for current deployment

- **Category:** Security / Abuse controls
- **Evidence:** `failedActionThrottle.ts` stores buckets in a process-local `Map`: `packages/backend/src/services/failedActionThrottle.ts:29-31`; comments explicitly say horizontal scale needs Redis later: `packages/backend/src/services/failedActionThrottle.ts:12-13`.
- **Impact:** Good enough for a single Railway instance. If the backend scales horizontally, rejected-action probing can be distributed across instances. It also does not cover unauthenticated auth-route probing, but those paths already have route-level credential limits.
- **Remediation:** Keep for this phase, but add a Phase 3 task to move failed-action counters and socket join counters to Redis/shared storage before horizontal scale or public mainnet.

### [M-02] Socket join-spam throttle is per socket, so reconnect spam can bypass it — Likely

- **Category:** Security / Reliability
- **Evidence:** `joinAttempts` is an array scoped inside each socket connection handler: `packages/backend/src/socket/index.ts:131-149`.
- **Impact:** It reduces accidental/log spam on one connection, but a scripted user can reconnect to reset the counter. Not a card-leak risk because `checkGameRoomJoin()` still enforces seat membership, but it is not a strong anti-abuse primitive.
- **Remediation:** Accept for dev/testnet. Before public mainnet, add per-user and/or per-IP socket join counters in shared storage, and log one coalesced `rate_limited` event per user/window.

### [M-03] `security_event` logging currently includes normal user mistakes — Possible

- **Category:** Observability / Security signal quality
- **Evidence:** Every action-route catch records a `security_event` before the code distinguishes bad gameplay requests from server errors or honest invalid actions: `packages/backend/src/api/games/index.ts:595-627`; ordinary `Cannot check`, `Nothing to call`, and `Not your turn` errors are then mapped to 400: `packages/backend/src/api/games/index.ts:638-652`.
- **Impact:** Operational dashboards may over-count normal misclicks/stale UI actions as adversarial events. This is not a merge blocker, but noisy security telemetry becomes ignored telemetry.
- **Remediation:** Split rejected actions into categories: `gameplay_reject` for expected poker-rule rejects, `security_event` for wrong-user, stale replay bursts, dead-seat, malformed input, throttle exceeded, and auth/socket probing.

## Positive Confirmations

- **Dead-seat reject placement is correct.** It runs after resolving the `GamePlayer` row and before the H-02 `hand.updateMany` version guard: `packages/backend/src/services/pokerActions.ts:63-71`, `packages/backend/src/services/pokerActions.ts:84-112`. That is the right placement for “no mutation if the active index ever points at folded/eliminated/all-in.”
- **Finite-number guard is correctly layered.** HTTP rejects non-finite numbers via Zod at `packages/backend/src/api/games/index.ts:528-535`; engine-level defence-in-depth rejects non-finite raises at `packages/backend/src/services/pokerActions.ts:94-103`.
- **Failed-action throttle clears on success.** Successful actions call `clearFailedActions()` after lifecycle emit: `packages/backend/src/api/games/index.ts:580-589`; the throttle module has reset/introspection tests.
- **JWT secret boot check is the right class of fix.** Production weak-secret fail-fast belongs in config boot rather than scattered runtime checks.
- **Bot fill admin callback was correctly migrated to header transport.** `botSession.ts` now sends `x-admin-secret` instead of body secret.

## Answers to Dave's Critical Questions

1. **Dead-seat reject placement:** Correct. Keep it where it is: after player lookup, before the H-02 guard and before any mutation.
2. **JWT tokenType transition:** For this branch, hard-reject wrong/missing token types and force re-login. If Dave insists on a transition, keep it very short and do not allow no-claim tokens to act as 7-day access tokens.
3. **Admin legacy transport:** Query fallback is not acceptable for merge. Header-only is the target. Body fallback is a short migration compromise at most; query should be removed now.
4. **Failed-action throttle scope:** `(userId, gameId)` is fine for authenticated gameplay probing on the current single-instance setup. IP/shared-store throttles are Phase 3/public-mainnet work, not this PR's blocker.
5. **Socket join-spam silent vs surfaced:** Return `{ ok:false, code:'rate_limited' }` to the client, but log one coalesced throttle event per socket/user/window. No per-attempt logs.

## Answers to Nice-to-haves

6. **Socket hole-card leakage tests:** Add later. HTTP `getGameState()` coverage is strong because socket personalized pushes use that path, but a socket-level regression test is still worth adding before mainnet.
7. **RNG statistical sanity:** 10k with loose tolerance is fine as a regression smoke test. It does not prove fairness, but it catches accidental replacement with broken deterministic/random code. Keep it lightweight.
8. **Audit-31 close style:** Treat this as an audit-31 document with a short fix list, not sign-off. After Dave fixes H-01/H-02, a quick re-review can be a sign-off note.

## Sign-off Decision

**Not cleared for merge to `main` yet.**

Fix before PR:

1. Require `tokenType: 'access'` on protected HTTP routes and socket auth.
2. Require `tokenType: 'refresh'` on `/api/auth/refresh`; preferably force re-login for no-claim legacy tokens in this pre-production phase.
3. Remove admin query-string secret fallback and update tests to assert query auth is rejected.

After those, I would be comfortable with a narrow re-review rather than another full anti-cheat pass.
