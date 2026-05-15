# Gerald — Brief: anti-cheat phase 2 scoping (audit-30)

**Date:** 2026-05-15
**Requester:** Dave
**Baseline:** `v0.9-pre-anticheat` @ commit `7cc7289` (live deploy, all audits 25–29 shipped)
**Status:** SCOPING. No code yet. I want your scope/priority call before I start writing tests or hardening.

## Why this brief

Anti-cheat phase 2 is the next production gate from your audit-24 list. It has the widest attack surface we've tackled — touches HTTP, sockets, JWT, DB version guards, room binding, side-channel data leaks — and the consequence of a miss is real money lost. I want your read on (a) what's already adequately defended, (b) what's untested but probably adequate, (c) what genuinely needs hardening, and (d) the right test/audit layout before I start writing code.

I'd rather over-scope this brief and under-ship than miss something.

## Current defensive surface (read-only audit)

### HTTP layer — `/api/games/:id/action`

- **`preHandler: authMiddleware`** (`packages/backend/src/middleware/auth.ts:42-69`). Calls `request.jwtVerify()`, then loads the user from DB. `request.user.id` is server-derived from the verified JWT payload, never from request body. Any client claim about "who I am" is ignored.
- **Per-user rate limit** (`api/games/index.ts:510-520`): `60/min` per authenticated user. Key generator falls back to IP if no user. Bypassable via `HARNESS_BYPASS_GLOBAL_RATELIMIT` env var (rejected in production).
- **Zod schema validation** on body: `action` must be one of `fold | check | call | raise | all-in`. `raiseAmount` optional number. No other inputs accepted. Anything else → 400.
- **Inside `processAction()`** (`services/pokerActions.ts:40-90`):
  - `Game not found` / `Game is not in progress` checks.
  - `No active hand` check.
  - **`Not your turn`** — verifies `currentHand.activePlayerIndex` matches the seat of the authenticated user. Authoritative; cannot be spoofed.
  - **`Player not found in game`** — verifies the authenticated user actually has a `GamePlayer` row for this game.
  - **H-02 optimistic concurrency guard** (`pokerActions.ts:78-89`): atomic `updateMany` on `{handId, activePlayerIndex, stage, version}`. Throws `Stale action - turn already advanced` if any concurrent request beat us. This blocks **replay attacks** and **double-submit** on the same turn.
- **Per-action validation by case**: check requires owed=0, call requires owed>0, raise enforces min-raise increment + stack cap, all-in caps to stack. Underflow / over-stack raises throw.

### Socket layer — `socket/index.ts`

- **JWT verify on handshake** (`socket/index.ts:76-95`). Token from `handshake.auth.token` OR `Authorization: Bearer`. Invalid/missing → connection rejected. `socket.userId = payload.userId` set ONCE at auth, never re-readable from client.
- **Auto-join `user:${userId}` room** at connect. Client cannot choose which user room. (`socket/index.ts:105`).
- **`join:game` handler** (`socket/index.ts:119`): server checks `GamePlayer` row exists for this user+game **before** joining the `game:${gameId}` room. Non-seated users get `not_seated` ack, room subscription denied. Tested in `tests/unit/socketAuthorization.test.ts` (7 cases).
- **No actions accepted via socket.** All player actions go via HTTP POST. Sockets are read-only push channel from server → client.

### Database / engine

- **Per-user PG advisory lock** in money-moving transactions (`services/userMoneyMutex.ts`). Serialises withdraw vs join races.
- **Active-game money lock** (H-04): `/withdraw` returns 409 while user is seated. Re-checked inside deposit credit + deduct transactions.
- **Side-pot math reads actual `HandAction.amount`** (committed contributions only). Cannot inflate eligibility by manipulating client payloads — server only counts what the DB rows say. (Gerald audit-29 verified.)
- **Hand version field** (`Hand.version`) increments per action. Used by H-02 guard.

### Admin layer

- **Constant-time `ADMIN_SECRET` check** in `isAdminSecretValid()`. Fail-fast at boot if missing/weak in production.

## Attack-surface catalogue — which surfaces are covered vs untested

For each surface I list: what an attacker would try, what the current defence is, and my best read on residual risk.

### 1. Replay attack — same action submitted N times

- **Attacker:** captures their own valid `POST /api/games/:id/action` and re-fires it after the turn advances.
- **Defence:** H-02 version guard. Atomic `updateMany` on `{handId, activePlayerIndex, stage, version}`. Second request finds `count === 0`, throws `Stale action`.
- **Residual risk:** **Low.** But — has the H-02 guard been adversarially tested with hundreds of concurrent identical requests rather than just the natural double-click case? I don't think so. Recommend a stress test.
- **Question for you:** is there any path where the version check is skipped or evaluated outside the transaction? Specifically: turnTimer auto-action calls `processAction` directly — does it go through the same H-02 guard? (I think yes, the guard is inside the transaction so all callers hit it, but please confirm.)

### 2. Wrong-user JWT — Alice's token claims to be Bob

- **Attacker:** signs a JWT claiming `userId: 'bob'` using a wrong secret OR sniffs Alice's token and tries to act as her.
- **Defence:**
  - Bad signature → `request.jwtVerify()` throws → 401.
  - Valid signature, valid payload → `request.user.id` is set to the JWT's `userId`, NOT to anything in the body. Even if body contains a `userId` field, it's ignored.
  - All downstream code uses `request.user!.id`.
- **Residual risk:** **Low PROVIDED**: (a) the JWT secret is strong and not leaked, (b) no route accepts a `userId` parameter from the body and trusts it. I'd like you to grep for any handler that reads `userId` from `request.body`. If there is even one, that's a P0.
- **Question for you:** is the JWT secret rotated? Does it have a kid claim for future rotation? Should this brief include a JWT rotation plan?

### 3. Out-of-turn actions

- **Attacker:** sends a `fold` / `raise` while it's another player's turn.
- **Defence:** `Not your turn` thrown inside `processAction` before any state mutation. Returns 400 to the client.
- **Residual risk:** **Low.** Inside a transaction; the H-02 guard would also catch a stale-turn submission.
- **Untested:** is there a race where two players' simultaneous submissions both pass the initial `activePlayerIndex` read but only one wins H-02? The losing one would see `Stale action` rather than `Not your turn`. Both are 400. Acceptable.

### 4. Raise above stack / negative bets / fractional micro-chips

- **Attacker:** sends `raiseAmount: 999999999` or `raiseAmount: -5` or `raiseAmount: 0.000001`.
- **Defence:**
  - Zod schema enforces `raiseAmount` is a number (no string, no object, no boolean).
  - Engine clamps: `if (actionAmount > playerChipStack) { actionAmount = playerChipStack; playerPosition = 'all_in' }`. So a giant raise becomes their stack-capped all-in.
  - Min-raise: `Raise must be at least N (min-raise rule)` throws unless `isAllInShove`.
  - Negative: `Invalid raise amount` if `raiseAmount <= 0`.
  - Fractional micro-chip: `BigInt(Math.floor(raiseAmount * 1_000_000))` rounds down. So `0.0000001` becomes `0` → caught by the `Invalid raise amount` check.
- **Residual risk:** **Low.** But there's an interesting case: `raiseAmount: NaN` or `raiseAmount: Infinity`. Does Zod's `z.number()` accept these? I think no, but worth testing explicitly.
- **Question for you:** any concern about `BigInt(Math.floor(NaN * 1_000_000))` blowing up in a way that doesn't reject cleanly? My read: `Math.floor(NaN)` is `NaN`, `BigInt(NaN)` throws `RangeError`. That'd surface as a 500. Cosmetic but worth catching as 400.

### 5. Modified socket payloads

- **Attacker:** intercepts client socket emit, modifies the payload, re-sends.
- **Defence:** **Sockets accept NO authoritative inputs from clients.** The only client→server socket event is `join:game` which takes a gameId — server checks seating before joining. Everything else (actions, deposits, etc.) goes through HTTP with JWT auth.
- **Residual risk:** **Very low.** Worth a one-page test that confirms no other client→server socket events exist or accept any state mutation. Grep `socket.on(` for all client-emitted events.

### 6. Folded-player actions

- **Attacker:** after folding, submits another action.
- **Defence:** `Not your turn` throws because `activePlayerIndex` has moved past their seat. Also `Player not found` won't fire (they're still in the GamePlayer row, just `position='folded'`).
- **Residual risk:** **Low.** Folded player is naturally locked out by turn-advancement. Worth a regression test.

### 7. Spectator / non-seated user actions

- **Attacker:** logged-in user who is NOT a seat at this game POSTs to `/api/games/:id/action`.
- **Defence:** inside `processAction`: `const player = game.players.find(p => p.userId === userId)` → if not found, `Player not found in game` throws.
- **Residual risk:** **Low.** But — is the response message safe? A 400 with `Player not found in game` reveals "this game exists but you're not in it" vs a 404 which would say "game doesn't exist". Information disclosure risk is tiny; mostly a tidiness call.

### 8. Eliminated-player actions (audit-28-related)

- **Attacker:** after elimination, submits an action.
- **Defence:** `position='eliminated'` players have no chips; engine's `Not your turn` should fire because they're skipped in turn advancement. But is there an explicit `if (player.position === 'eliminated') throw` check? I don't see one.
- **Residual risk:** **Low but worth verifying.** If a hand's `activePlayerIndex` somehow lands on an eliminated seat (it shouldn't post-audit-27, but defensively…), can an eliminated player act? I don't think so, but a test confirming this would be cheap.

### 9. Hole-card leakage to non-recipients

- **Attacker:** subscribes to a `user:${otherUserId}` room and sniffs hole cards.
- **Defence:** auto-join is hard-coded to `user:${socket.userId}` at connect. The `join:user` event explicitly ignores any client-supplied userId. So clients cannot join other users' rooms.
- **Residual risk:** **Low PROVIDED** there's no other way to subscribe to those rooms. Worth a defensive test: client emits a forged `socket.join('user:other-user-id')` somehow → should fail or be a no-op.
- **Worth checking:** does socket.io allow client-side `.join()` at all? My read is no — `.join` is server-side only. Confirm.

### 10. Pre-flight game state queries

- **Attacker:** repeatedly polls `GET /api/games/:id/state` for someone else's game to scrape data.
- **Defence:** `getGameState(id, userId)` blanks `holeCards` for non-self players (except at showdown). Non-participants get a 404 from `getGameState`.
- **Residual risk:** **Low.** But the 3s waiting-room polling introduced 2026-05-15 means EVERY seated client polls this endpoint every 3s during lobby. That's now part of the rate budget. No issue today; worth knowing if we tighten the 60/min ceiling later.

### 11. Crypto / deposit / withdrawal (mostly out of scope here)

- Out of scope for this anti-cheat brief — they're H-04 active-game lock territory and were covered in earlier audits. But mention if you see a cross-cutting concern.

### 12. Bot / admin endpoints

- Bot-fill, cancel-game, add-chips, kill-bots: gated by `ADMIN_SECRET`. In production, secret is strong and lives in Railway env vars. Bot-fill additionally gated by `ALLOW_BOT_FILL=1`.
- **Residual risk:** **Low IF the secret is secure.** Worth a test that proves these endpoints reject without the secret. Should already pass.

## What I think genuinely needs hardening

These are my best guesses; tell me which are real and which are noise.

1. **NaN/Infinity raise amount → graceful 400 instead of 500.** Tiny, but should be a clean catch.
2. **Stress test for H-02 guard** with concurrent identical requests (e.g. 50 parallel POSTs of the same action). Confirm exactly one succeeds, rest get clean 400s with `Stale action`.
3. **Explicit eliminated-player rejection.** Add `if (player.position === 'eliminated') throw new Error('You are eliminated from this game')` as defence in depth, even though turn-advancement should make it unreachable.
4. **Audit log for adversarial rejections.** Every rejected action with reason should go to AppLog with severity hint, so if someone IS probing, we have a paper trail. Already happens for most cases via `logError`; worth confirming coverage.

## Proposed test layout

I want a new top-level `tests/security/` directory with these files. Each file holds one attack class, tests are red-team-style "attacker tries X, expect 400/401/etc, no state change":

- `tests/security/auth.test.ts` — JWT cases: missing, malformed, wrong secret, expired, valid-but-wrong-user-claim, no user record.
- `tests/security/replay.test.ts` — H-02 stress test: N parallel identical POSTs, exactly one succeeds.
- `tests/security/out-of-turn.test.ts` — folded, eliminated, not-active-seat, never-joined.
- `tests/security/raise-bounds.test.ts` — negative, NaN, Infinity, > stack (clamped to all-in), < min-raise (rejected unless all-in), micro-amounts.
- `tests/security/socket-subscription.test.ts` — non-seated cannot join game room; client cannot join other-user room.
- `tests/security/admin-auth.test.ts` — every admin endpoint rejects without secret; constant-time comparison verified.
- `tests/security/hole-card-leakage.test.ts` — `getGameState` blanks others' holeCards pre-showdown; reveals at showdown for players still at the table.

Tests use the same `vi.mock` + sim/world pattern as existing unit tests, plus a small helper for "build a forged request with X token".

## What I want from you

### Critical (must-answer)

1. **Scope:** do you agree with the 12-surface catalogue? Anything missing? Anything you'd cut as over-scoping?
2. **Order of priority:** which 2–3 surfaces should I tackle FIRST? My instinct is replay (H-02 stress), eliminated-player explicit reject, and the security test suite scaffold. Yours?
3. **Hardening list:** which of my four hardening suggestions are real? Any I'm missing?
4. **JWT rotation / kid claim:** is this in scope for phase 2, or a separate phase?
5. **Penetration approach:** should we hire / consult an external pen-tester before going to monitored mainnet, or is "Dave writes red-team tests + Gerald reviews" sufficient for the next stage of the production-gate ladder?

### Nice-to-have

6. **Audit log severity:** should rejected adversarial actions write a separate `security_event` category in AppLog, distinct from normal `action` rejections? Could be useful for ops dashboards.
7. **Rate-limit ceiling:** current 60/min per user for actions. Tight enough for human play, generous for naive scripted attacks. Should we add a lower ceiling for repeated-failure responses (e.g. 5 failed-actions/min → 429 with backoff)?
8. **Any surfaces from your prior audits (24, 25, 26) that you flagged and we didn't fully close?** I want to make sure the phase-2 work doesn't claim "DONE" while leaving older flags open.

## Out of scope for this brief

- Crypto deposit/withdrawal hardening (separate gate, audit-24 item #1).
- Multi-instance / horizontal-scale concerns (the H-02 advisory lock + dedupe sets are process-local; a separate phase will address when we scale beyond 1 Railway dyno).
- Smart-contract audit (we don't have one yet; that's a much later phase).
- General load testing.

## Files I read for this brief

- `packages/backend/src/api/games/index.ts` — action endpoint, auth, rate limit, Zod schema
- `packages/backend/src/middleware/auth.ts` — JWT verify
- `packages/backend/src/socket/index.ts` — handshake auth, room join, seating check
- `packages/backend/src/services/pokerActions.ts` — H-02 guard, action validation
- `packages/backend/src/services/userMoneyMutex.ts` — PG advisory lock
- `packages/backend/src/services/closeGame.ts` + audit trail
- `packages/backend/tests/unit/socketAuthorization.test.ts` — existing socket auth tests

## Ask

Read the catalogue, pick what's in scope for phase 2, answer Q1–Q5, flag anything I missed. I will NOT write code until you've signed off on the scope. Once we agree on what to ship, I'll write the test suite + any hardening, you review the diff, then we ship.

Brief written against baseline `v0.9-pre-anticheat` at commit `7cc7289`.
