# Gerald — Brief: narrow re-review after audit-31 fixes (audit-32)

**Date:** 2026-05-15
**Requester:** Dave
**Branch:** `anticheat-phase-2` HEAD = `96a54ed`
**Predecessor:** your audit-31 review at `0b8f5d8`
**Status:** READY FOR NARROW RE-REVIEW per your sign-off plan ("After Dave fixes H-01/H-02, a quick re-review can be a sign-off note").

## What you flagged and what I did

### H-01 — Refresh tokens still work as access tokens

**Diagnosis you gave:** `/refresh` rejected `tokenType: 'access'`, but `authMiddleware` and socket auth accepted any valid JWT regardless of tokenType. Practical access-token lifetime was still 7 days.

**Fix landed (commit `96a54ed`):**

1. `middleware/auth.ts` — `authMiddleware` now rejects any token where `payload.tokenType !== 'access'`. 401 with explicit message.
2. `middleware/auth.ts` — `optionalAuthMiddleware` returns without attaching a user if `tokenType !== 'access'`. Optional-auth routes treat non-access callers as anonymous.
3. `socket/index.ts` — `io.use` handler rejects any token where `payload.tokenType !== 'access'` before setting `socket.userId`. Logs `wrong token type` on rejection.
4. `api/auth/index.ts` — `/refresh` REQUIRES `payload.tokenType === 'refresh'`. Previously accepted missing claim with a warning; now rejects with 401. Per your call: pre-production is the right moment to force re-login rather than carry a 7-day legacy hole.

**Tests:**
- `tests/security/auth-jwt.test.ts` updated: every existing test's signed token now includes `tokenType: 'access'`. Plus 4 new tests proving the strict enforcement (refresh = 401, legacy no-claim = 401, bogus tokenType = 401, happy-path access = 200).
- `tests/security/auth-refresh.test.ts` (new file, 6 tests): proves `/refresh` only accepts refresh tokens; the access token it returns carries `tokenType: 'access'` for the next-step chain.

### H-02 — Admin query-string secret transport remains active

**Diagnosis you gave:** `getAdminSecretFromRequest()` falls back to body then query. Query was the most dangerous transport (browser history, proxy logs, referrers).

**Fix landed (commit `96a54ed`):**

1. `api/admin/index.ts` — `getAdminSecretFromRequest()` no longer reads from `request.query`. Even if `?secret=...` is present, it's treated as no-secret and returns null.
2. Body fallback retained as a short migration compromise on POST routes only (still emits a deprecation warning per call). Header is the production-supported path.

**Tests:**
- `tests/security/admin-auth.test.ts` — the "still accepts admin secret via query" test FLIPPED to `audit-31 H-02: REJECTS admin secret via query string (403)`. Plus one new test asserting that a request with BOTH query-secret AND a valid header still authenticates via the header (query is ignored, not rejecting).
- `tests/unit/botFill.test.ts` — one existing test was doing `GET /api/admin/bots?secret=...`; migrated to header transport.

### M-03 — security_event includes normal user mistakes

**Diagnosis you gave:** every rejected action wrote `security_event`, drowning real probing signal in honest gameplay errors.

**Fix landed (commit `96a54ed`):**

1. `services/appLogger.ts` — `AppLogCategory` extended with `'gameplay_reject'`.
2. `api/games/index.ts` — rejection logging now categorises at write time. Pattern test on the error message:
   - `gameplay_reject` for: `Not your turn`, `Cannot check`, `Nothing to call`, `min-raise`, `Stale action`, `Raise must be higher`, `Invalid raise amount`, `Raise amount must exceed`.
   - `security_event` for everything else AND any throttle-exceeded path regardless of message (the burst itself is signal).

## Summary

| Finding | Status |
|---|---|
| **H-01** Refresh tokens as access | ✅ Fixed — strict tokenType on HTTP + sockets + /refresh |
| **H-02** Admin query secret | ✅ Fixed — query path removed; body deprecated; header only |
| **M-01** Throttle process-local | ⏸ Accepted for phase 2 (per your audit-31 verdict; Redis later) |
| **M-02** Reconnect bypasses socket throttle | ⏸ Accepted for phase 2 (per your audit-31 verdict) |
| **M-03** Security event noise | ✅ Fixed — split into gameplay_reject vs security_event |

## Test counts

- Branch baseline (post audit-30, pre this fix): 221 tests
- After audit-31 fix: **232 tests** (+11)
- `tests/security/` total: 76 tests across 9 files
- All pass. Frontend builds clean.

## Diff for your review

```bash
git fetch origin
git log 0b8f5d86d6589210b15b0013cca204e48ac63ef3..origin/anticheat-phase-2 --oneline
git diff 0b8f5d86d6589210b15b0013cca204e48ac63ef3..origin/anticheat-phase-2
```

That's the narrow window: just the fix commit (and the audit-31 response doc I copied into the workspace for tracking). Should be a small diff.

## Key files to read

- `packages/backend/src/middleware/auth.ts` lines ~50-90 — tokenType check in both middlewares
- `packages/backend/src/socket/index.ts` lines ~80-115 — tokenType check on socket handshake
- `packages/backend/src/api/auth/index.ts` lines ~180-225 — /refresh strict check
- `packages/backend/src/api/admin/index.ts` lines ~40-85 — query path removed
- `packages/backend/src/api/games/index.ts` lines ~605-635 — gameplay_reject vs security_event split
- `packages/backend/src/services/appLogger.ts` — new category in the union

## Question for you

The only judgement call I'd like your eyes on:

**Body-secret transport on admin POST routes.** I kept it as a short migration window with a deprecation warning. The only thing using it in-repo now is one or two harness tests; production tooling can migrate to the header at any time. Are you comfortable leaving body fallback in, or do you want me to remove it in this commit too? My instinct: leave for one more release cycle so I can scan downstream callers (any external admin scripts? cron jobs?) and confirm nothing breaks, then remove in a follow-up.

## Ask

1. Diff the change.
2. Spot-check the 4 areas (`middleware/auth`, `socket/index`, `auth/index`, `admin/index`).
3. Sign off, or flag any residual concern.

If clean → I open the PR to `main` and we land it. Production stays untouched until your sign-off.
