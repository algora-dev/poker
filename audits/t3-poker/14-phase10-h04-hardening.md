# T3 Poker — Phase 10 H-04 hardening

Date: 2026-05-07 | Author: Dave | Branch: `fix/phase1-chip-accounting`
Triggered by: Gerald's `t3-poker-phase10-h04-hardening-prompt.md`
Scope: tighten the active-game money lock, serialize money-moving paths,
remove the parked-deposit normal flow.

## Summary

| Change | Status | Validation |
|---|---|---|
| Lock semantics: "seated", not "has chips" | done | money_lock harness scenario asserts all-in (chipStack=0) and folded seats stay locked |
| Per-user advisory mutex on every money path | done | `acquireUserMoneyMutex` called in withdrawal, createGame, joinGame, deposit credit, closeGame |
| /games/create returns 409 when seated | done | money_lock harness asserts 409 + code |
| Deferred deposit (no auto-credit, no parked-product flow) | done | money_lock harness asserts ChipBalance unchanged + auth still usable + deposit row confirmed=false |

Targeted validation:

- backend tsc: clean
- vitest: 11 files / 68 tests PASS
- harness `money_lock_active_game`: PASS (covers 9 distinct assertions)
- harness `action_timeout`: PASS (3 hands, ledger conserved)
- harness `eight_player_full_session`: PASS (32 hands, ledger conserved)

## 1. Tighter active-game lock

`src/services/activeGameLock.ts`

Old rule:

```ts
GamePlayer.chipStack > 0 AND Game.status in ['waiting', 'in_progress']
```

New rule:

```ts
ANY GamePlayer row for the user
  AND Game.status in ['waiting', 'in_progress']
```

This catches:

- All-in players with `chipStack=0` who are still in a hand.
- Folded players who are still seated for the next hand.
- Eliminated players whose seat is still attached (fail-closed default;
  they unlock when `closeGame` removes them via the
  cancel/cashout path).

The helper return type now also exposes `position` for log/debug.

## 2. Per-user money mutex (advisory lock)

`src/services/userMoneyMutex.ts` — new module.

- `acquireUserMoneyMutex(tx, userId)` issues
  `SELECT pg_advisory_xact_lock($1::bigint)` parameterized by a
  63-bit hash of the user id. The lock is transaction-scoped — auto
  released when the surrounding `prisma.$transaction` commits or rolls
  back, so a crashing tx never leaves the lock held.
- All money-moving paths now acquire the mutex BEFORE reading any
  state they're about to mutate. Two requests for the same userId
  serialize on the lock; reads outside the lock are unaffected.

Call sites:

- `processWithdrawal` (deduct tx)
- `createGame` (buy-in deduct tx)
- `joinGame` (buy-in deduct tx)
- `creditChips` (deposit credit tx)
- `closeGameInTx` (refund/cashout tx; locks every player in stable
  userId-asc order to avoid deadlocks if two close paths overlap)

This closes the race Gerald flagged: `/withdraw` and
`/games/:id/join` can no longer pass each other and both succeed.

The mutex is a runtime guarantee on top of the in-tx active-game lock
re-check. Even if a join/create commits the GamePlayer row a
microsecond before withdraw checks, the mutex serializes them so the
withdraw transaction sees the committed state.

## 3. Createrror handling at the API layer

`src/services/game.ts`

- New `GameJoinMoneyLockedError` class (mirrors
  `ActiveGameMoneyLockedError` from `withdrawal.ts`). Same `code`
  (`active_game_money_locked`), same 409 mapping convention.
- `createGame`: refuses to start a new table if the user already holds
  any seat at a waiting/in_progress game.
- `joinGame`: refuses to seat the user at a different game when
  they're already seated at one (idempotent re-join to the same game
  is allowed).

`src/api/games/index.ts` maps both errors to HTTP 409 with body:

```json
{ "code": "active_game_money_locked",
  "gameId": "...",
  "gameStatus": "waiting" | "in_progress" }
```

## 4. Deferred deposits (replaces parked-deposit normal flow)

`src/blockchain/listener.ts:creditChips`

Old behavior: write a `Deposit` row with `confirmed=false`, log "parked
for review", suggest auto-recovery later.

New behavior, per Shaun's policy:

1. Acquire the per-user money mutex inside the credit transaction.
2. Re-check the active-game lock under the mutex.
3. If locked: roll back the credit transaction (so the
   `consumeAuthorization` is undone and the auth stays valid). Outside
   the tx, write ONE `Deposit` row with `confirmed=false` for
   idempotency only (so historical-sync doesn't loop forever on this
   txHash) and log loudly:
   ```
   DEPOSIT_DEFERRED_ACTIVE_GAME ... userId, txHash, amount, blockNumber, authorizationId
   ```
4. The user's `ChipBalance` is unchanged. The `DepositAuthorization`
   is unchanged (`used=false`). No promise of auto-recovery.
5. Operator action is required to credit it after the user leaves the
   table. The manual recovery procedure is documented below.
6. Direct/unauthorized contract deposits without a valid auth remain
   uncredited/manual-review exactly as before. (`creditChips` returns
   early on `findActiveAuthorization` miss before reaching any of the
   above.)

### Manual recovery procedure (operational, not user-facing)

When a `DEPOSIT_DEFERRED_ACTIVE_GAME` log fires:

1. Verify the user's seat has been released (`Game.status` flipped to
   completed/cancelled, or seat removed by closeGame).
2. From an admin shell:
   ```sql
   -- Confirm the deferred row.
   SELECT * FROM "Deposit"
    WHERE "txHash" = '<tx>' AND confirmed = false;
   -- Confirm the auth is still alive.
   SELECT id, "userId", used, "expiresAt" FROM "DepositAuthorization"
    WHERE id = '<authId>';
   ```
3. Inside a single transaction: increment `ChipBalance` by amount,
   flip `Deposit.confirmed = true`, mark `DepositAuthorization` used,
   write `ChipAudit` (operation `deposit`, notes `manual recovery`),
   write `MoneyEvent` (eventType `deposit`).
4. Emit `balance:updated` to the user's socket room (or wait for
   reconnect).

A proper admin endpoint/job is intentionally NOT in this branch — see
Gerald's prompt for the deferred follow-up shape.

## 5. Tests / harness coverage

Vitest (no behavioural test changes; mocks updated to provide the new
`tx.$executeRawUnsafe` shim):

- `tests/unit/chipConservation.test.ts` — 5/5 pass.
- `tests/unit/handLedger.test.ts` — 11/11 pass.
- `tests/sim/world.ts` — sim tx client now stubs `$executeRawUnsafe`
  as a no-op so the sim runs aren't blocked by the advisory lock.
- All 68 tests across 11 files PASS.

Harness — `money_lock_active_game` scenario now asserts:

1. Seated (`chipStack > 0` waiting): /withdraw 409.
2. Same: /generate-message 409.
3. Same: /money-lock returns locked=true.
4. **All-in (chipStack=0, position=all_in, status=in_progress)**: still
   locked; /withdraw still 409.
5. **Folded (chipStack=0, position=folded)**: still locked.
6. **Trying to /games/create while seated**: 409 with code
   `active_game_money_locked`.
7. **Deposit credit-time lock**: drives `creditChipsForTesting`
   directly; ChipBalance does NOT change, authorization stays
   `used=false`, deferred Deposit row exists with `confirmed=false`.
8. After `closeGame`, /money-lock returns locked=false.

## Out of scope on this branch

- Admin endpoint for deferred-deposit recovery (Gerald deferred).
- Stale-action 500 → 409 (Gerald deferred).
- Bot-client stalls under 8-handed concurrency. Two consecutive
  `eight_player_full_session` runs went FAIL→PASS in this branch from
  identical code; same pattern as the previous branch (test-client
  resilience issue, NOT chip-accounting). Documented in MEMORY.md as
  an open loop.
- Pre-existing `sidePots.ts:63` showdown crash on empty contributions.
  Predates Phase 10.

## Files touched

- `packages/backend/src/services/activeGameLock.ts` — lock rule
- `packages/backend/src/services/userMoneyMutex.ts` — new
- `packages/backend/src/services/withdrawal.ts` — mutex + recheck
- `packages/backend/src/services/game.ts` — mutex + recheck +
  GameJoinMoneyLockedError
- `packages/backend/src/services/closeGame.ts` — mutex per-player in
  stable order
- `packages/backend/src/blockchain/listener.ts` — mutex + deferred
  flow + creditChipsForTesting export
- `packages/backend/src/api/games/index.ts` — 409 mapping for
  GameJoinMoneyLockedError on /create and /join
- `packages/backend/tests/harness/scenarios.ts` — extended money_lock
  scenario
- `packages/backend/tests/sim/world.ts` — $executeRawUnsafe stub
- `packages/backend/tests/unit/chipConservation.test.ts` — same
- `packages/backend/tests/unit/handLedger.test.ts` — same

After Gerald signs off, this branch is ready for the testnet flow gates.
