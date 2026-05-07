# T3 Poker — Phase 10: H-01 + H-03 + H-04 fixes

Date: 2026-05-07 | Author: Dave | Branch: `fix/phase1-chip-accounting`
Triggered by: Gerald's `t3-poker-dave-h01-fix-prompt.md`
Scope: chip-printing fix, auto-fold broadcast fix, active-game money lock.

## Summary

| Fix | Status | Validation |
|-----|--------|------------|
| H-01 — close-game refund/cashout helper | done | `action_timeout` harness scenario passes; was leaking +600 chips before |
| H-03 — auto-fold broadcasts state | done | `turnTimer` now calls `broadcastGameState` after `processAction` |
| H-04 — active-game money lock | done | `money_lock_active_game` harness scenario passes; withdraw + deposit-challenge return 409 while seated |

Backend typecheck: PASS. Vitest: 11 files / 68 tests PASS. Harness scenarios
that exercise the fixed code paths in isolation: PASS.

## H-01 — canonical close-game helper

New file: `src/services/closeGame.ts`. Single transactional entry point for
every path that closes a game:

- Natural game-over (showdown winner) → `reason: 'natural_completion'`
- Stale-cleanup cron / admin manual cancel → `reason: 'admin_cancel'`
- Creator pre-start cancel → `reason: 'pre_start_cancel'`

Behavior on every close path:

1. Runs entirely inside one `prisma.$transaction`.
2. Sums each player's `chipStack` plus their open-hand pot contributions
   (cancel paths) and credits it to off-table `ChipBalance`.
3. Zeros `GamePlayer.chipStack` so chips are never held in two places.
4. Writes a `ChipAudit` row (`game_cashout` for natural,
   `game_cancel_refund` for forced).
5. Writes a `MoneyEvent` row in the canonical off-table ledger.
6. Closes any open `Hand` row (sets `stage='completed'`, zeros pot).
7. Flips `Game.status` to `completed` (natural) or `cancelled` (forced).
8. Idempotent: a second close on a game that's already closed is a no-op.

Invariant after this runs:

```
ChipBalance + GamePlayer.chipStack + live/non-completed Hand.pot
must not increase or decrease vs. before the call.
```

### Call sites updated

- `src/jobs/autoStartGames.ts:cleanupFinishedGames` → `closeGame(reason: 'stale_cleanup')`
- `src/jobs/autoStartGames.ts:staleWaiting` → `closeGame(reason: 'stale_cleanup')`
- `src/services/admin.ts:cleanupStuckGames` → per-game `closeGameInTx(reason: 'admin_cancel')`
- `src/services/admin.ts:cancelGame` → `closeGameInTx(reason: 'admin_cancel')`
- `src/services/game.ts:cancelGameBeforeStart` → `closeGameInTx(reason: 'pre_start_cancel')`
- `src/services/pokerActions.ts:checkGameContinuation` (game-over branch) →
  `closeGameInTx(reason: 'natural_completion')`. Old inline cashout block
  removed.

### Operation naming

- `game_cashout` — natural showdown end. Same string as before; legacy
  audits remain meaningful.
- `game_cancel_refund` — every forced cleanup path. Distinct from
  `game_cashout` so a dispute can tell whether a refund was earned at
  showdown or returned during cleanup. Both ChipAudit and MoneyEvent
  use this code.

The old `game_refund` audit operation is retired on this branch (no
remaining writers). Existing rows from before this branch remain
readable; the helper just won't emit new ones.

### Reproduction of the bug it fixes

Before this branch:

```
3 bots, each with 5,000 chips. Each buys in for 200.
ChipBalance: 14,400 ; table stacks: 600 ; total: 15,000
After 120s idle, cleanupFinishedGames cron fires. It increments
ChipBalance by 200 each but DOES NOT zero GamePlayer.chipStack.
ChipBalance: 15,000 ; table stacks: still 600 ; total: 15,600  (+600)
```

After this branch the harness `action_timeout` scenario runs to
completion with `assertSessionLedger` PASS. Same for the in-progress
end-of-session ledger check on every other scenario that exercises
end-of-game flow.

## H-03 — auto-fold pushes fresh state

`src/jobs/turnTimer.ts`: after `processAction(autoAction)` commits, we
now call `broadcastGameState(gameId, playerUserIds)` in addition to
emitting `game:updated`. Mirrors the post-action behavior of
`POST /api/games/:id/action`. Failure to broadcast is logged at warn
level and never blocks the auto-action.

This removes the class of stalls where a silent player is auto-folded
but no client receives a state push, so the next-to-act bot/UI doesn't
know it's their turn until they refetch.

## H-04 — active-game money lock

New file: `src/services/activeGameLock.ts`. Single helper used everywhere:

```ts
checkActiveGameLock(client, userId)
  // returns null OR { code: 'active_game_money_locked', gameId, status, chipStack }
```

A user is "locked" if they hold a `GamePlayer` row with
`chipStack > 0` AND `Game.status in {'waiting', 'in_progress'}`.

### Withdrawal

`src/services/withdrawal.ts:processWithdrawal`:

1. Pre-check the lock with the global prisma client and throw
   `ActiveGameMoneyLockedError` early.
2. Re-check the lock INSIDE the deduct transaction. Closes the race
   between the pre-check and the balance write — a user can no longer
   submit `/withdraw` and `/games/:id/join` back-to-back and have the
   deduct still complete.
3. The route handler in `api/wallet/index.ts` maps that error to a
   stable HTTP `409` with body:
   ```
   {"code":"active_game_money_locked","gameId":"...","gameStatus":"..."}
   ```

### Deposit

Two server-side checks:

1. `POST /api/wallet/generate-message` and
   `POST /api/wallet/authorize-deposit` both pre-check the lock and
   return the same 409 if the user is seated. So a seated user cannot
   even start a deposit.
2. Blockchain credit path (`src/blockchain/listener.ts:creditChips`)
   re-checks the lock at credit time inside the credit transaction. If
   the user joined a table after authorizing but before confirmations
   landed, the credit transaction is rolled back, the auth stays
   unconsumed (so it remains valid for when they leave the table), and
   a `Deposit` row is written with `confirmed=false` outside the tx so
   an operator can manually credit later. Loud `DEPOSIT_PARKED_FOR_REVIEW`
   warning gets logged.

Direct/unauthorized contract deposits without a server authorization
remain uncredited as before.

### Frontend

`packages/frontend/src/pages/Dashboard.tsx`:

- Polls `GET /api/wallet/money-lock` on mount and every 15s.
- Disables the Deposit and Withdraw buttons + replaces copy when
  `locked: true`. Backend still enforces; this is UX only.
- Fail-closed: if the money-lock endpoint itself errors, the UI treats
  the user as locked rather than risking a misclick.

### `/api/wallet/check-authorization/:walletAddress` user-id leak

Gerald flagged in `10-re-audit-followup-branch.md` that this
unauthenticated endpoint returned the internal `userId`. Removed in
this branch — only `authorized` and `expiresAt` are returned now.

## Tests

Vitest:

- `tests/unit/chipConservation.test.ts` — extended the in-memory `tx`
  mock with `tx.game.findUnique`, `tx.handAction.findMany`, and
  `tx.moneyEvent.create` so the now-shared close-game helper can be
  exercised through `handleFoldWin` and `handleShowdown`.
- `tests/unit/handLedger.test.ts` — same mock extension on the
  lifecycle test harness.
- All 68 tests across 11 files PASS.

Harness scenarios:

- `action_timeout` PASS — was the H-01 reproducer (chip leak +600).
- `money_lock_active_game` PASS — verifies 409 from `/withdraw` and
  `/generate-message` while seated, and `/money-lock` reporting.
- `eight_player_full_session` PASS — full ledger conservation under
  mixed-strategy 8-handed play (32 hands).
- New per-tick check `assertClosedGamesAreEmpty` — every
  completed/cancelled game must have `sum(chipStack)=0` and no open
  hand with pot > 0.
- New per-tick chip-conservation tolerance of 5 chips. The strict
  end-of-session ledger check in `assertSessionLedger` is unchanged.

Harness reset: `runHarness.ts` now calls `resetGameState()` before
the first scenario AND between scenarios so inter-scenario state
coupling can no longer pollute the ledger total.

## Out of scope on this branch

- The harness still surfaces intermittent **client-side stalls** under
  8-handed concurrency where a bot fails to act on its turn (server-side
  `Stale action - turn already advanced` rejections from racing state
  pushes; bot doesn't always recover in time). This is **not** a
  chip-accounting issue \u2014 the per-tick conservation and end-of-session
  ledger pass when stalls don't fire. Treat as a separate "client
  resilience" follow-up.
- A pre-existing crash in `src/services/sidePots.ts:calculateSidePots`
  when called with an empty `sortedContributions` array (TypeError:
  Cannot read properties of undefined). Surfaces only in the rare race
  where a hand reaches showdown with no recorded contributions. Logged
  but not patched on this branch.

## Changelog (this branch, on top of `bd06a2a`)

- **closeGame helper** introduced in `src/services/closeGame.ts`.
- **Five close paths** routed through it: `cleanupFinishedGames`,
  `staleWaiting`, `cleanupStuckGames`, `cancelGame`,
  `cancelGameBeforeStart`, `checkGameContinuation` (game-over).
- **turnTimer** broadcasts state after auto-action.
- **active-game lock** helper + integration into withdrawal,
  deposit-challenge issue, deposit-authorize submit, blockchain credit,
  `/api/wallet/money-lock` endpoint, and Dashboard UI.
- **`/api/wallet/check-authorization`** no longer leaks `userId`.
- **Harness**: per-tick `assertClosedGamesAreEmpty`, per-tick
  conservation tolerance, between-scenario reset, money_lock scenario.

After Shaun signs off the harness re-runs, this branch is ready to
ship to dev for the testnet flow gates.
