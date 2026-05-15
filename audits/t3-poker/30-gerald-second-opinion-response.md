# Audit: T3 Poker — Audit 30 Anti-Cheat Scope Review
Date: 2026-05-15 | Auditor: Gerald | Scope: Dave’s `30-gerald-anticheat-brief.md` plus read-only verification of backend source at `7cc7289a86e3a1723a51dac4c0a69a53def0cd75`

## Executive Summary
- Dave’s 12-surface catalogue is directionally right and mostly well-scoped for protocol-level anti-cheat. I would **not cut it**; I would add a few missing surfaces: admin-secret transport, socket join/log spam, JWT lifecycle/secret strength, RNG/deck auditability, and collusion/bot-assistance as a later operational layer.
- The current core action path is much stronger than earlier audits: HTTP action auth is server-derived, socket actions are not accepted, H-02 version guard is inside `processAction()`, and turnTimer uses the same `processAction()` path.
- Priority order should be: **(1) action/replay adversarial tests**, **(2) explicit invalid-seat/action rejection + finite-number validation**, **(3) socket/admin auth tests and security-event logging/rate limiting**.
- JWT rotation / `kid` should be a **separate auth-hardening phase**, but phase 2 should still add token type claims and production JWT-secret strength validation because those are cheap and directly relevant.
- For the next monitored dev/testnet gate, “Dave red-team tests + Gerald review” is sufficient. Before public real-money/mainnet with unknown players, get at least a lightweight external pen-test focused on auth, wallet/money flows, socket visibility, and adversarial game actions.

## Verified Baseline
- Repo HEAD matched Dave’s baseline: `7cc7289a86e3a1723a51dac4c0a69a53def0cd75` on `main`.
- Working tree had Dave’s new brief untracked: `?? audits/t3-poker/30-gerald-anticheat-brief.md`.
- Prior memory still says T3 is not public-production-cleared until manual deposit/withdrawal, 8-player live playtest, anti-cheat/adversarial pass, and broader load/concurrency confidence pass are done. Source: `MEMORY.md#L37-L38`.

## Answers to Dave’s Critical Questions

### Q1 — Scope: do I agree with the 12-surface catalogue?
**Yes, with additions.** Dave’s listed surfaces are the right phase-2 spine. I would keep all 12.

Add these surfaces:
1. **Admin secret transport and exposure** — current admin GET endpoints take `secret` in query string (`/refund-log`, `/logs`, `/bots`), which can leak via browser history, server/proxy logs, screenshots, and referrers. Evidence: `packages/backend/src/api/admin/index.ts:125`, `:184`, `:438`.
2. **Socket join spam / DB-log amplification** — rejected `join:game` writes AppLog rows (`socket/index.ts:119-149`). A malicious authenticated user can spam invalid joins and create DB/log volume unless per-socket throttled.
3. **JWT lifecycle** — not full `kid` rotation yet, but token type, refresh-token handling, and JWT secret strength should be in scope enough to test and document. Current refresh route accepts any valid JWT-shaped token because access/refresh share `{ userId }` with no `tokenType`. Evidence: `packages/backend/src/api/auth/index.ts:64-73`, `:129-137`, `:187-207`.
4. **RNG/deck auditability** — current shuffle uses `crypto.randomInt`, which is good, and deck commitment exists. Keep this as a regression surface so nobody reintroduces `Math.random()`. Evidence: `packages/backend/src/services/poker/deck.ts:1`, `:40-48`; `holdemGame.ts:188-209`.
5. **Collusion / external assistance / multi-account patterns** — not a code-hardening blocker for phase 2, but it is real anti-cheat. Put it in “phase 3 ops detection,” not this protocol test pass.

### Q2 — Priority: first 2–3 surfaces
My order:

1. **Replay/concurrency action tests first.** Stress H-02 with parallel identical actions and simultaneous cross-player stale-turn submissions. This protects the money/game-state core.
2. **Action input + seat-state hardening second.** Add finite-number validation and explicit rejection for `folded`, `eliminated`, and `all_in` seats before any mutation if the active index ever points at a dead/non-decision seat.
3. **Socket/admin/security-event tests third.** Cover room auth, no client state mutation over sockets, admin secret rejection, and security-event logging/rate limiting.

### Q3 — Which hardening suggestions are real?
All four are real, with modifications:

1. **NaN/Infinity → clean 400:** real, but over-the-wire JSON cannot normally carry `NaN`/`Infinity`. Still add `z.number().finite()` or equivalent because internal tests/injection and future route changes can hit this. Also `processAction()` directly does `BigInt(Math.floor(raiseAmount * 1_000_000))`, so non-finite values are ugly failure paths. Evidence: `games/index.ts:527-531`; `pokerActions.ts:386-389`.
2. **H-02 stress test:** real. Existing unit coverage tests a stale guard shape, but I did not see a high-volume HTTP-style “50 concurrent same action” test. Evidence of existing stale unit: `tests/unit/concurrencyGuard.test.ts:414-421`.
3. **Explicit eliminated-player rejection:** real, but broaden it. Reject any action if `player.position` is `folded`, `eliminated`, or `all_in`. Today `processAction()` checks turn by active index/user and then fetches player, but does not explicitly reject those positions before the switch. Evidence: `pokerActions.ts:45-62`.
4. **Audit log for adversarial rejections:** real. There is action logging and error logging (`games/index.ts:535-536`, `:598-599`; `pokerActions.ts:714-715`), but distinguish expected gameplay errors from suspicious repeated invalid actions. Use category `security` or `security_event`, not just generic `action` errors.

Additional hardening I would add:
- Move admin secret from query/body to a header (`X-Admin-Secret` or bearer-style admin token), especially for GET endpoints.
- Add per-user failed-action throttle: e.g. 5 invalid action attempts/minute/game/user → 429/backoff, while preserving normal 60/min valid action ceiling.
- Add per-socket throttling for `join:game` and `join:user`, plus do not AppLog every repeated rejection from the same socket/game in a tight window.
- Add `JWT_SECRET` production strength checks similar to `ADMIN_SECRET` checks. Current production validation requires JWT_SECRET to exist, but does not enforce length/placeholder resistance. Evidence: `config.ts:53-65`, `:73-87`.

### Q4 — JWT rotation / `kid`: in phase 2 or separate?
**Separate phase.** Do not block anti-cheat phase 2 on full `kid` rotation.

But include these cheap phase-2 auth fixes/tests:
- Add `tokenType: 'access' | 'refresh'` claims and make `/api/auth/refresh` accept only refresh tokens.
- Add JWT secret length/placeholder validation in production.
- Document current rotation playbook: rotating `JWT_SECRET` invalidates all sessions; acceptable for early testnet, not ideal for mature production.

Full `kid` support, dual-key verification, refresh-token rotation/revocation, and device/session tables are an auth-hardening phase before broad public mainnet.

### Q5 — External pen-tester before monitored mainnet?
For **monitored dev/testnet with allowlisted/friendly users**, Dave’s red-team tests + Gerald review is enough if the test suite lands and manual playtest passes.

For **public real-money/mainnet**, get an external pen-test. Scope it narrowly so it is affordable and useful:
- JWT/auth/session handling
- action endpoint replay/concurrency
- socket room/hole-card visibility
- admin endpoints and secrets
- deposit/withdrawal/ledger invariants
- rate limits and log-amplification paths

## Findings

### [H-01] Admin secret in query-string GET endpoints is a real exposure risk — Confirmed
- **Evidence:** `/refund-log` parses `secret` from query (`packages/backend/src/api/admin/index.ts:125`), `/logs` reads `query.secret` (`:184-188`), `/bots` parses query secret (`:438-442`). Admin secret validation itself is constant-time and refuses empty values (`admin/index.ts:21-35`), but transport is weak.
- **Impact:** Admin secret can leak into browser history, reverse-proxy logs, support screenshots, monitoring traces, or referrer paths. In a real-money game, leaked admin secret is high-impact because admin endpoints include chip adjustment and bot/session controls.
- **Remediation:** Move admin authentication to `Authorization: Bearer <admin-secret>` or `X-Admin-Secret` header for every admin endpoint. Keep body `secret` only temporarily for backward compatibility, then remove. Never accept admin secret in query strings.

### [H-02] Action path needs explicit dead-seat rejection before mutation — Likely
- **Evidence:** `processAction()` validates active index maps to user and verifies a `GamePlayer` exists (`pokerActions.ts:45-62`), then immediately claims the H-02 guard and enters action switch. No explicit `player.position in ['folded','eliminated','all_in']` rejection appears before mutation. Turn advancement and timer code try to avoid dead active seats (`turnTimer.ts:45-96`, `:128-130`), but that is indirect.
- **Impact:** If a future bug or race leaves `activePlayerIndex` on an eliminated/folded/all-in seat, that user could submit an action through an unreachable-but-dangerous path. For example, a folded/all-in player should never be able to fold away equity or create odd action rows.
- **Remediation:** After loading `player`, before the version guard or immediately after it, reject:
  ```ts
  if (player.position === 'folded' || player.position === 'eliminated' || player.position === 'all_in') {
    throw new Error('Player cannot act from current seat state');
  }
  ```
  Add regression tests that force activePlayerIndex onto each dead state and prove no `HandAction` / stack / pot mutation occurs.

### [H-03] Refresh/access JWTs are not typed; rotation can wait, but token-type checks should not — Confirmed
- **Evidence:** Signup/login both sign access and refresh tokens with only `{ userId }`, differing only by expiry (`api/auth/index.ts:64-73`, `:129-137`). `/refresh` verifies any JWT and returns a new access token from `payload.userId` (`:187-207`).
- **Impact:** This is not a direct game-action cheat while access tokens are short-lived, but it weakens session semantics and makes future rotation/revocation harder. It also makes tests unable to assert “access token rejected on refresh endpoint.”
- **Remediation:** Add `tokenType` claim and enforce it. Consider `jti` and server-side refresh-token rotation/revocation in the later auth-hardening phase.

### [M-01] `raiseAmount` should be finite at schema and engine boundaries — Confirmed
- **Evidence:** HTTP schema uses `z.number().optional()` (`games/index.ts:527-531`). Engine converts with `BigInt(Math.floor(raiseAmount * 1_000_000))` (`pokerActions.ts:386-389`).
- **Impact:** Wire JSON usually blocks `NaN`/`Infinity`, but relying on parser behaviour is fragile and internal direct calls/tests can still hit ugly exceptions. The desired security posture is typed 400, no 500/no noisy internal error.
- **Remediation:** Use `z.number().finite().optional()` and add engine-level `Number.isFinite(raiseAmount)` before conversion. Mirror this for admin numeric inputs where relevant (`add-chips`, `spawn-bots`, buy-in amounts).

### [M-02] Socket authorization is good, but event spam/log amplification is missing from scope — Likely
- **Evidence:** Server-side socket events are limited to `join:user`, `join:game`, `leave:game`, `disconnect` (`socket/index.ts:109`, `:119`, `:158`, `:171`). `join:game` correctly checks seating before room join (`socket/index.ts:119-153`), but both accept/reject paths can write AppLog rows (`:134-149`).
- **Impact:** Authenticated attackers can spam invalid joins and force DB writes/log noise. This is not chip theft, but it affects ops visibility and could become a cheap nuisance DoS.
- **Remediation:** Add per-socket/per-user throttles and rejection coalescing. Test that repeated invalid `join:game` attempts do not produce unlimited DB writes.

### [M-03] Hole-card leakage surface is mostly well-defended, but keep tests at both API and socket layers — Confirmed
- **Evidence:** `getGameState()` rejects non-participants (`holdemGame.ts:334-338`) and returns only `myPlayer.holeCards` for the requesting user while opponents get `holeCards: []` (`holdemGame.ts:378-393`, `:447`). `broadcastGameState()` emits personalized state to `user:${userId}` rooms (`socket/index.ts:294-336`). Hand ledger blocks mid-hand private-card payload keys (`handLedger.ts:54-80`, `:117-135`).
- **Impact:** Current design is right. The risk is regression: someone emits full game state to `game:${gameId}` later for convenience.
- **Remediation:** Add tests that fail if pre-showdown opponent cards appear in `GET /state`, `broadcastGameState`, `game:action`, `game:updated`, or hand-ledger in-flight events.

### [M-04] JWT secret production strength is not validated — Confirmed
- **Evidence:** `JWT_SECRET` is required (`config.ts:53-65`) but only `ADMIN_SECRET` has production length/default validation (`config.ts:73-87`).
- **Impact:** A weak JWT secret collapses the entire auth model. Dave correctly treats wrong-user JWT risk as low only if the secret is strong and not leaked.
- **Remediation:** Add production validation: non-empty, length >= 32 bytes/chars minimum, reject known placeholders. Prefer 256-bit random base64/hex secret.

### [I-01] H-02 guard is in the shared action path, including turnTimer — Confirmed
- **Evidence:** Version guard is inside `processAction()` (`pokerActions.ts:68-89`). HTTP action route calls `processAction()` (`games/index.ts:551`). Turn timer also calls `processAction()` (`turnTimer.ts:173`) after a process-local de-stampede lock (`turnTimer.ts:24-43`, `:135-139`).
- **Impact:** Dave’s read is correct: human and timer paths hit the same version guard. The remaining need is stress coverage, not architectural change.

### [I-02] RNG/deck handling is currently a positive pattern worth preserving — Confirmed
- **Evidence:** Shuffle uses `crypto.randomInt` (`poker/deck.ts:1`, `:40-48`), and hand start records a deck commitment hash before play (`holdemGame.ts:188-209`).
- **Impact:** This is materially better than many early poker implementations. Keep it covered by tests so it does not regress.
- **Remediation:** Add a test that scans/guards `shuffleDeck()` against `Math.random()`, and a ledger test that every hand records `deck_committed` before actions.

## Recommended Test Layout
Dave’s proposed `tests/security/` layout is good. I would adjust it like this:

1. `auth-jwt.test.ts`
   - missing/malformed/wrong secret/expired
   - access token rejected on refresh once `tokenType` exists
   - no user record → 401
   - body `userId` ignored

2. `action-replay-concurrency.test.ts`
   - 50 parallel identical actions → exactly one success, all others clean stale/400, no double debit
   - simultaneous out-of-turn/stale player submission → no mutation
   - timer auto-action and human action racing same turn → one settlement/lifecycle

3. `action-input-bounds.test.ts`
   - negative, zero, micro below one chip unit, non-finite, above-stack all-in clamp, under-min raise rejected unless all-in

4. `seat-state-actions.test.ts`
   - folded/eliminated/all-in active index forced → action rejected, no mutation
   - spectator/non-seated → safe error

5. `socket-authorization.test.ts`
   - current checks plus invalid `join:user` cannot select other room
   - no state-mutating socket events exist
   - join spam throttled / log coalesced

6. `hole-card-leakage.test.ts`
   - API state and socket personalized state hide opponents pre-showdown
   - showdown reveal only after completion
   - hand ledger rejects private cards in in-flight events

7. `admin-auth.test.ts`
   - every admin endpoint rejects missing/wrong secret
   - admin secret accepted via header, not query
   - bot-fill disabled unless `ALLOW_BOT_FILL=1`

8. `rng-ledger.test.ts`
   - shuffle uses crypto RNG
   - every hand emits `deck_committed` before action events

## Production-Gate Verdict
Approve Dave to start phase-2 implementation with this scope. Do **not** let the phase close as “anti-cheat done” until:
- the adversarial action/security tests exist and pass,
- explicit dead-seat action rejection lands,
- finite numeric validation lands,
- admin secret query transport is removed or at least deprecated behind header auth,
- failed-action/security-event logging and throttling are in place,
- socket join spam is rate-limited/coalesced,
- JWT token-type and secret-strength checks are added or explicitly scheduled as the next auth-hardening task.

This is enough for monitored testnet. It is not enough to claim public real-money production clearance without the remaining money-flow manual tests, live 8-player playtest, load/concurrency pass, and a narrow external pen-test before broad mainnet.
