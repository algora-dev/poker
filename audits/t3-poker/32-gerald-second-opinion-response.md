# Audit: T3 Poker — Anti-cheat Phase 2 Narrow Re-review
Date: 2026-05-15 | Auditor: Gerald | Scope: audit-31 fix commit `96a54ed` on `anticheat-phase-2`

## Executive Summary

- **Sign-off for PR/merge to `main` for monitored dev/testnet:** yes, with the existing caveat that T3 Poker is still **not public-production/mainnet cleared** until the broader manual flow, playtest, and load/concurrency gates are complete.
- **Audit-31 H-01 is fixed:** protected HTTP routes, optional auth, socket auth, and `/api/auth/refresh` now enforce token type strictly.
- **Audit-31 H-02 is fixed:** admin query-string secrets are no longer accepted. Correct secret in `?secret=` now fails unless a valid header is also present.
- **M-03 is improved:** rejected action logs are now split into `gameplay_reject` vs `security_event`, which should materially reduce noisy security telemetry.
- **Residual judgement call:** body-secret fallback on admin POST routes is acceptable for one short migration window on monitored dev/testnet, but I would remove it or disable it in production before public real-money launch.

## Review Basis

- Repo: `C:\Users\Jimmy\.openclaw\workspace-dave\poker`
- Branch inspected: `anticheat-phase-2`
- Current branch HEAD during review: `19703ced41de4421ef073eb7a7fdfb53062d7956` (`docs(audit-32)` brief commit)
- Fix commit reviewed: `96a54ed` — `fix(security): audit-31 H-01 + H-02 + M-03`
- Narrow diff inspected: `0b8f5d86d6589210b15b0013cca204e48ac63ef3..96a54ed`
- Tests were **not run** by Gerald because Dave's repo is read-only from my role unless Shaun explicitly approves the exact command.

## Findings

### [Resolved H-01] Refresh tokens no longer work as access tokens — Confirmed

- **Evidence:**
  - `authMiddleware` rejects anything where `payload.tokenType !== 'access'`: `packages/backend/src/middleware/auth.ts:71-76`.
  - `optionalAuthMiddleware` refuses to attach a user for refresh/legacy tokens: `packages/backend/src/middleware/auth.ts:111-115`.
  - Socket auth rejects non-access tokens before setting `socket.userId`: `packages/backend/src/socket/index.ts:94-108`.
  - `/api/auth/refresh` now requires `payload.tokenType === 'refresh'`: `packages/backend/src/api/auth/index.ts:199-218`.
  - New tests cover HTTP protected-route tokenType enforcement and `/refresh` strictness: `packages/backend/tests/security/auth-jwt.test.ts`, `packages/backend/tests/security/auth-refresh.test.ts`.
- **Assessment:** This closes the core audit-31 auth hole. Access tokens are back to 15-minute practical authority; refresh tokens cannot be used directly on protected HTTP routes or sockets.
- **Residual note:** I found no socket-level test specifically proving a refresh token cannot connect to Socket.IO. The source fix is clear, so this is **not a merge blocker**, but Dave should add that regression test before public mainnet.

### [Resolved H-02] Admin query-string secret transport removed — Confirmed

- **Evidence:**
  - `getAdminSecretFromRequest()` now checks header, then body fallback only; it explicitly does not read `request.query`: `packages/backend/src/api/admin/index.ts:62-79`.
  - Search only found `?secret=` in comments/tests, not as accepted runtime auth logic.
  - Tests now assert correct query-string secret returns `403`: `packages/backend/tests/security/admin-auth.test.ts`.
- **Assessment:** This fixes the high-risk leakage path from audit-31. Query secrets are now ignored, which is the right behaviour.
- **Minor cleanup:** `packages/backend/src/api/admin/index.ts:490` still has a comment `GET /api/admin/bots?secret=...`; update that comment to avoid reintroducing the pattern later. Not a blocker.

### [Improved M-03] Rejection logging split into gameplay vs security categories — Confirmed

- **Evidence:**
  - `AppLogCategory` now includes `gameplay_reject`: `packages/backend/src/services/appLogger.ts:28-35`.
  - Action route now classifies expected poker-rule rejects separately from probing-shaped rejects: `packages/backend/src/api/games/index.ts:611-625`.
  - Throttle-exceeded still escalates to `security_event`, which is correct.
- **Assessment:** Good improvement. This should make ops/security signal more useful. The message-regex classifier is a bit brittle, but acceptable for this phase.

## Answer: Body-secret transport on admin POST routes

I am comfortable leaving body fallback **only as a short monitored migration window** for this branch merge, because:

- the dangerous query-string transport is gone;
- header wins over body;
- body fallback logs a deprecation warning;
- in-repo admin callers have mostly moved to headers;
- this branch is still headed to monitored dev/testnet, not public real-money mainnet.

But I would put a clear follow-up on Dave's list:

1. Scan any external cron/support/admin scripts.
2. Move them to `X-Admin-Secret`.
3. Remove `body.secret` fallback before public production/mainnet.

If Dave wants the cleanest security posture now, removing body fallback immediately is better. But I would not block this PR solely on body fallback now that query auth is dead.

## Remaining Non-blockers

- **Socket tokenType regression test missing:** source enforces access-token-only sockets, but add a Socket.IO handshake test for refresh-token rejection before mainnet.
- **Process-local throttles:** accepted from audit-31 for Phase 2. Redis/shared counters are still needed before horizontal scale/public mainnet.
- **Admin POST body fallback:** acceptable short-term, remove before public mainnet.
- **Stale admin comment:** update `GET /api/admin/bots?secret=...` comment.

## Sign-off Decision

**Cleared for PR/merge to `main` for monitored dev/testnet.**

Do **not** interpret this as public-production/mainnet clearance. It only clears the narrow audit-31 fix set: tokenType enforcement, admin query-secret removal, and rejection-log categorisation.
