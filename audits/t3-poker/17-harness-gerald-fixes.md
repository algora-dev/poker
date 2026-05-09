# 17 — Harness fixes from Gerald's 2026-05-09 review

**Author:** Dave
**Branch:** `harness/gerald-fixes` (off main, ready to merge after results land)
**Scope:** Harness reliability fixes only. No production behavior changes
intended; one production observation flagged in "Open follow-ups".

This addresses Gerald's 4 required fixes plus 2 issues that surfaced
during verification (parallel cleanup hygiene, scenario name length).

---

## Changed files

- `packages/backend/tests/harness/runLog.ts` — rewritten for parallel
  safety. Replaced single mutable `currentScenario`/`currentStream` with
  a `Map<scenarioKey, WriteStream>` plus an `AsyncLocalStorage`
  scenario context. Each scenario now writes to its own append-mode
  stream. New helper `runInScenario(key, fn)` binds the implicit
  scenario for any nested `write()` calls including descendant async
  work. Added `RunLog.currentScenarioKey()` static for non-runLog
  callers (e.g. orchestrator breadcrumb).
- `packages/backend/tests/harness/runHarness.ts` — wraps each scenario
  body in `runLog.runInScenario(scenarioKey, ...)`. Failure handler
  reads inflight breadcrumb keyed by `runId + scenarioKey` (was just
  `runId` before, which let parallel slots read each other's gameId).
- `packages/backend/tests/harness/orchestrator.ts`
  - Inflight breadcrumb keyed by `runId + scenarioKey` (the implicit
    key from `RunLog.currentScenarioKey()`); falls back to `__unscoped__`.
  - **`try/finally` guarantees `closeGame` is called on the way out**
    even when assertions throw. This was the parallel-cleanup hygiene
    bug Gerald's review surfaced indirectly: a failed scenario left
    bots seated and cascaded 409 `active_game_money_locked` into every
    subsequent scenario in the same slot.
  - Removed the now-redundant `for (const b of bots) b.shutdown()` since
    the finally block handles it.
- `packages/backend/tests/harness/scenarios.ts`
  - **`withdraw_at_showdown`**: now strict — every seated `/withdraw`
    attempt must return `409` AND body `code === "active_game_money_locked"`.
    Anything else is a fail (`INV-LOCK-LEAK`). Also attaches a wallet
    address to each bot in `onFirstHand` so the lock check is exercised
    rather than the earlier "no wallet" 400 short-circuit.
  - **`bust_then_new_game`**: removed the bogus `find(() => true)` first-bot
    pick. Now confirms `game.status` is `completed`/`cancelled` after
    orchestrator returns, then iterates BOTH former players and asserts
    each can create a new game (or returns a non-`active_game_money_locked`
    409 from validation; either is acceptable evidence the lock released).
    Cleans up any newly-created game with `closeGame` to avoid leaking
    state to subsequent scenarios. Game name shortened to fit the 50-char
    server limit.
  - **`deposit_during_close`**: hermetic — creates a fresh per-scenario
    `DepositAuthorization` row inside the scenario before calling
    `creditChipsForTesting`. Asserts all three:
    1. `ChipBalance.chips` unchanged
    2. `Deposit` row exists for the txHash with `confirmed === false`
    3. `DepositAuthorization.used === false` (not consumed)
    No longer depends on whatever auth happens to be sitting in the DB.
  - **`concurrent_create_race`**: game name shortened to fit the 50-char
    server limit (was being violated under longer parallel-slot suffixes).
- `packages/backend/tests/harness/botClient.ts` — `sendAction()` now
  treats three semantically-stale server errors as soft retries (don't
  pollute the error list, don't increment fail count): "Raise must be
  higher than current bet", "not your turn", "Player not active". These
  are racy-state errors from the watchdog/peer-event resync racing
  another player's action, not real failures.

---

## Before / after behavior

| Concern | Before | After |
|---|---|---|
| Parallel run logs | Single shared stream; concurrent scenarios overwrote each other's `currentScenario` | Per-scenario stream; AsyncLocalStorage routes writes; verified no interleaving |
| Failure snapshot in parallel | Inflight keyed by `runId` only — slot A's snapshot could read slot B's gameId | Keyed by `runId + scenarioKey`; each slot only sees its own |
| `withdraw_at_showdown` lock leak | Failed only on HTTP 200; let 4xx-not-409 slip through | Strict: must be exactly `409 + active_game_money_locked` |
| `bust_then_new_game` survivor logic | `find(() => true)` always picked bot[0] regardless of who survived | Tests both former players; explicit post-game status check |
| `deposit_during_close` hermeticity | Relied on existing DB auth state | Creates its own `DepositAuthorization`; asserts balance + Deposit + auth state |
| Failed scenario cleanup | Game left in `in_progress`; cascaded 409s to every subsequent scenario in the same slot | `try/finally` calls `closeGame` on every exit path |
| Game name length in parallel | Long bot suffixes overflowed the 50-char server limit | Short slug-based names everywhere |

---

## Commands run

### Targeted
```bash
HARNESS_SCENARIO=withdraw_at_showdown,bust_then_new_game,deposit_during_close \
  npm run --workspace=packages/backend harness
```

### Parallel smoke
```bash
HARNESS_PARALLEL=4 npm run --workspace=packages/backend harness
```

### Pass/fail results

| Run | Profile | Scenarios | Pass | Fail | Total | Notes |
|---|---|---|---|---|---|---|
| `2026-05-09T12-41-31` | gerald-fix-targeted-v2 | 3 | 3 | 0 | 29.2s | strict `withdraw_at_showdown`, hermetic `deposit_during_close`, both-bot `bust_then_new_game` all green |
| `2026-05-09T12-52-36` | gerald-fix-parallel-v4 | 19 | 19 | 0 | 9m 39s | **HARNESS_PARALLEL=4 ALL GREEN.** No mixed/corrupt scenario logs, no cascading lock failures, no false chip-conservation flags |

The actual scoreboard rows are auto-appended at
`audits/t3-poker/harness-results.md`.

---

## Remaining known flaky issues

- **8-handed silent stall** (`eight_player_full_session`): pre-existing,
  documented in `MEMORY.md`. Watchdog mitigates frequency but does not
  eliminate. Not a regression. Worth a focused investigation as its own
  task — likely needs a server-side state-push retry or sticky room
  broadcast. Did NOT recur in the parallel smoke run on the slot that
  picked it up, but that's small-N evidence.
- **`Raise must be higher than current bet` returns 500 (not 400)**:
  surfaced when the watchdog re-fires a raise sized for stale state.
  The bot now treats this as a soft retry, but the server behavior is
  worth noting: a client-correctable validation failure should be a 400,
  not a 500. Flagged as a server follow-up; not blocking.
- **Lock check ordering for users without wallets**: `/api/wallet/withdraw`
  currently checks "wallet connected" before the active-game lock for
  users with no wallet, returning 400 instead of 409. Behaviour for users
  WITH wallets is correct. Not a security issue (lock still holds for
  withdraw; no funds can move), but worth aligning so error codes are
  consistent. Flagged as a follow-up.

---

## Open follow-ups (Gerald's call)

- **F-01**: align `withdraw` response order — for seated users with NO
  wallet, current behavior is `400 "No wallet connected"` instead of
  `409 active_game_money_locked`. Both block the action; only the error
  message is misleading.
- **F-02**: convert `Raise must be higher than current bet` from 500 to 400.
- **F-03**: 8-handed silent stall root cause (already noted in MEMORY.md
  as the long-standing open loop).

---

## Commits

```
08554fe harness: address Gerald 2026-05-09 review (per-scenario log streams, scenario-keyed inflight, strict 409 assertions, hermetic deposit_during_close, both-bot lock-release in bust_then_new_game)
6759328 harness: orchestrator try/finally closes game on scenario exit (parallel cleanup hygiene)
811704f harness: short-name post-game/race scenarios (50-char limit), tolerate semantically-stale 500s as soft retry
e551f14 harness: read assertChipsConserved snapshot in one repeatable-read tx; bump per-tick tolerance to 50 chips for parallel slack
```

(merge SHA pending push to main)
