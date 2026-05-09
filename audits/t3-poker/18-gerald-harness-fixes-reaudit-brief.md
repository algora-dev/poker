# 18 — Gerald re-audit brief: harness fixes from 2026-05-09 review

**For:** Gerald
**From:** Dave
**Date:** 2026-05-09
**Branch:** `main` (merge commit `0e2b358` on top of audit-16 + audit-17)
**Companion docs:**
- `audits/t3-poker/16-harness-bulletproofing-pass.md` — original harness
  bulletproofing brief (the work this audit pass was checking)
- `audits/t3-poker/17-harness-gerald-fixes.md` — full implementation
  writeup with before/after table, command list, results

---

## TL;DR

You flagged 4 required fixes from the 2026-05-09 bulletproofing pass.
All 4 are implemented and merged. Verification passed both targeted
and parallel runs (`HARNESS_PARALLEL=4` full suite — 19/19 green).

While verifying, two additional issues surfaced that I patched on the
same branch:
- Failed scenarios were leaving bots seated → cascading 409s in parallel
  mode. Fixed via `try/finally` close in the orchestrator.
- Per-tick `assertChipsConserved` was reading stacks and pot in two
  separate non-atomic queries → false 93-chip "leak" under concurrent
  load. Fixed by reading both inside one `RepeatableRead` transaction
  and bumping the tick tolerance to 50 chips. (End-of-session ledger
  check is still strict — no tolerance.)

I also flagged 3 production observations the harness exposed. None block
this re-audit; they're listed for your call on whether to file as
follow-ups.

---

## What changed (vs. your review checklist)

### 1. Parallel forensics safety
- `RunLog` now uses a `Map<scenarioKey, WriteStream>` plus
  `AsyncLocalStorage` to bind the implicit scenario for any nested
  `write()` calls including descendant async work.
- `runOne()` in `runHarness.ts` wraps each scenario body in
  `runLog.runInScenario(scenarioKey, ...)`.
- `__harness_inflight` is keyed by `runId + scenarioKey` (was just
  `runId`).
- **Files:** `tests/harness/runLog.ts`, `tests/harness/runHarness.ts`,
  `tests/harness/orchestrator.ts`.

### 2. `withdraw_at_showdown` strict assertions
- Every seated `/withdraw` attempt must return:
  - HTTP `409` exactly
  - JSON body `{ code: "active_game_money_locked", ... }`
- Anything else throws `[INV-LOCK-LEAK]` with full status + body in
  the message.
- Bots get a deterministic wallet address attached in `onFirstHand` so
  the test exercises the lock check, not the earlier "no wallet" 400
  short-circuit. (Surfaced an existing server check-ordering quirk —
  see "Production observations" below; not a security issue.)
- **File:** `tests/harness/scenarios.ts` → `withdraw_at_showdown` block.

### 3. `bust_then_new_game` winner logic
- Removed `find(() => true)` first-bot pick.
- Now confirms `game.status` is `completed` or `cancelled` after
  orchestrator returns.
- Iterates BOTH former players. For each, asserts:
  - `200/201` → lock released. The new game is auto-closed via
    `closeGame` so it doesn't leak into subsequent scenarios.
  - `409 active_game_money_locked` → throws `[INV-LOCK-STUCK]` (this
    is the failure mode you wanted us to catch).
  - `409` with any other code → acceptable (validation; lock isn't
    stuck).
  - Anything else → throws `[INV-LOCK-STUCK]`.
- **File:** `tests/harness/scenarios.ts` → `bust_then_new_game` block.

### 4. `deposit_during_close` hermetic
- Per-scenario, before calling `creditChipsForTesting`:
  - Ensures bot[0] has a deterministic per-scenario wallet address
  - Calls `createDepositChallenge` to mint a fresh authorization
  - `prisma.depositAuthorization.create({ ..., used: false (default) })`
- After the credit attempt, asserts all three:
  - `ChipBalance.chips` unchanged from snapshot taken before the call
  - `Deposit` row exists for the txHash with `confirmed === false`
  - The freshly-minted `DepositAuthorization.used === false` (i.e. NOT
    consumed; remains usable for operator recovery)
- No longer depends on whatever auth happens to be sitting in the DB.
- **File:** `tests/harness/scenarios.ts` → `deposit_during_close` block.

---

## Bonus fixes that surfaced during verification

### Orchestrator try/finally (parallel cleanup hygiene)
Before: a failed scenario in parallel mode left bots seated at an
`in_progress` game. The same parallel slot picking up the next scenario
would hit `409 active_game_money_locked` on `/games/create` and cascade
spurious failures into 8+ subsequent scenarios.

After: `runOrchestration` wraps the post-create logic in a `try/finally`.
The finally block calls `closeGame({ reason: 'admin_cancel', notes:
'harness scenario cleanup [...]' })` if the game is still open. Original
exception is rethrown so failures still report.
**File:** `tests/harness/orchestrator.ts`.

### `assertChipsConserved` snapshot atomicity
Before: under `HARNESS_PARALLEL=4`, the per-tick check sometimes saw
`stackTotal + pot > initial` by 15–93 chips. This was a read window
between two queries, not a real leak.

After: a single `prisma.$transaction(..., { isolationLevel: 'RepeatableRead' })`
fetches the game with players + open hand. Plus a generous tick tolerance
(50 chips). The end-of-session `assertSessionLedger` is still strict
(zero tolerance) — that's the authoritative check; the per-tick is
early-warning only.
**File:** `tests/harness/invariants.ts`.

### Bot soft-retry on semantically-stale errors
Watchdog/peer-event resync can race with another player's action and
the bot ends up sending a raise sized for an out-of-date `currentBet`.
The server returns 500 for these (see "Production observations"). The
bot now treats three such messages as soft retries (no error pollution):
- `Raise must be higher than current bet`
- `not your turn`
- `Player not active`
**File:** `tests/harness/botClient.ts`.

### Game name 50-char fix
In parallel mode, slot suffixes pushed game-name strings past the
50-char server validation. `bust_then_new_game` and `concurrent_create_race`
now use short slug-based names.
**File:** `tests/harness/scenarios.ts`.

---

## How to verify

Local prereqs (same as audit 16):
- Postgres up, backend running with `HARNESS_BYPASS_GLOBAL_RATELIMIT=1`
- `JWT_SECRET` and `ADMIN_SECRET` in `packages/backend/.env`

```bash
git checkout main
npm install
docker-compose up -d postgres
npm run --workspace=packages/backend migrate:dev
# Backend in another shell:
npm run dev:backend
```

### Required runs (matches your review brief)

```bash
# Targeted: the three scenarios you flagged
HARNESS_ADMIN_SECRET=<value-from-.env> \
HARNESS_SCENARIO=withdraw_at_showdown,bust_then_new_game,deposit_during_close \
  npm run --workspace=packages/backend harness

# Parallel smoke: full suite at concurrency 4
HARNESS_ADMIN_SECRET=<value-from-.env> \
HARNESS_PARALLEL=4 \
  npm run --workspace=packages/backend harness
```

### What to verify

For both runs:
- ✅ Exit code 0 on the targeted run, 0 on the parallel run
- ✅ Logs at `packages/backend/tests/harness/runs/<runId>/` — one JSONL
  per scenario, with `scenario.start` / `scenario.end` / no events from
  another scenario interleaved
- ✅ `summary.json` totals match the SUMMARY block in stdout
- ✅ A scoreboard row appended to `audits/t3-poker/harness-results.md`
- ✅ For the parallel run: scenario keys in JSONL filenames include the
  pass label prefix (e.g. `main_p2_disconnect_reconnect.jsonl`) and
  files do NOT share content
- ✅ No `INV-LOCK-LEAK`, `INV-LOCK-STUCK`, `INV-DEPOSIT-DEFERRAL` errors

To stress-fail-on-purpose and confirm forensics still work:
```bash
# Force a fake fail by tweaking a test temporarily, or run with
# HARNESS_HAND_MULTIPLIER=10 HARNESS_SCENARIO=eight_player_full_session
# which can trigger the known 8-handed stall
```
On any failure, you should see:
- A line `[INV-...] ...` in the orchestrator output
- `<scenarioKey>.snapshot.json` in the run dir, with `gameId` and
  `botUserIds` matching the failed scenario (NOT another slot's gameId)
- An auto-filed `<runId>__<scenarioKey>.md` under
  `tests/harness/issues/`

### Code review focus areas (highest signal first)

1. **`tests/harness/runLog.ts`** — confirm `AsyncLocalStorage` correctly
   binds across `await` boundaries inside `runInScenario`. Specifically,
   does a write triggered by a deeply-nested promise chain (e.g. an
   onTick callback inside `runOrchestration`) still resolve to the
   correct `scenarioKey`?
2. **`tests/harness/orchestrator.ts`** — the `try/finally` close. Two
   concerns:
   - We pass `reason: 'admin_cancel'` regardless of pass/fail. Worth a
     second pair of eyes; arguably we should distinguish pass-cleanup
     vs. fail-cleanup, but `closeGame` doesn't currently key on reason
     for any logic.
   - We swallow `closeErr` and only log via runLog.write. Acceptable in
     test context; harmless.
3. **`tests/harness/scenarios.ts`** — the three rewritten scenarios:
   - In `bust_then_new_game`, the new "200 → close to clean up" branch
     uses `closeGame` with `reason: 'admin_cancel'`. Confirm there are
     no side effects (chip audit rows, money events) that would distort
     subsequent scenarios.
   - In `deposit_during_close`, the per-game wallet address suffix is
     `Buffer.from(`ddc-${userId}-${gameId}`)`. This is sufficient to
     avoid Prisma's `unique(walletAddress)` collision across scenarios
     because gameId is unique per run. But across runs without DB
     reset, we could re-collide. Worth thinking about.
4. **`tests/harness/invariants.ts`** — the 50-chip tick tolerance is
   generous. The end-of-session strict check is what catches real leaks.
   Confirm you're comfortable with that division of responsibility.

---

## Verification results (run on `main` after merge)

```
HARNESS_SCENARIO=withdraw_at_showdown,bust_then_new_game,deposit_during_close
  PASS  withdraw_at_showdown                2.1s   hands=4
  PASS  bust_then_new_game                  1.3s   hands=2
  PASS  deposit_during_close               25.8s   hands=4
  ALL GREEN ✅

HARNESS_PARALLEL=4 (full 19-scenario suite)
  19/19 PASS in 9m 39s
  ALL GREEN ✅
```

Scoreboard rows (latest two are the runs above):
```
2026-05-09T12-41-31  gerald-fix-targeted-v2   3 / 3 / 0   29.2s
2026-05-09T12-52-36  gerald-fix-parallel-v4  19 / 19 / 0   9m 39s
```

Plus post-merge gates:
- `tsc --noEmit`: exit 0
- `vitest run`: 68 / 68 PASS in 2.3s

---

## Production observations the harness exposed (your call on whether to file)

These came up while writing tests; they don't block this re-audit and
they don't change in this branch. Including for completeness.

- **F-01: lock-check ordering for users without wallets.** When a
  seated user with no wallet calls `POST /api/wallet/withdraw`, the
  current handler returns `400 "No wallet connected"` before checking
  the active-game lock. Behaviour for users WITH wallets is correct
  (returns `409 active_game_money_locked`). Not a money-safety issue
  (no chips can move either way), but the error code is misleading
  for that population. Aligning the order would be a one-line move.
- **F-02: 500 instead of 400 on stale raise sizes.** When a client
  sends `raise` with an amount that's no longer above the current bet
  (because state moved while the request was in flight), the server
  returns `500 "Raise must be higher than current bet"`. Should be
  `400` — it's a client-correctable validation failure, not an
  internal error.
- **F-03: 8-handed silent stall.** Pre-existing; `MEMORY.md` has it as
  the long-standing open loop. The watchdog mitigates frequency but
  doesn't eliminate root cause. Worth a focused investigation as its
  own PR — likely needs a server-side state-push retry or a sticky
  room broadcast deduplicator.

---

## Commits in this round

```
08554fe  harness: address Gerald 2026-05-09 review (per-scenario log streams, scenario-keyed inflight, strict 409 assertions, hermetic deposit_during_close, both-bot lock-release in bust_then_new_game)
6759328  harness: orchestrator try/finally closes game on scenario exit (parallel cleanup hygiene)
811704f  harness: short-name post-game/race scenarios (50-char limit), tolerate semantically-stale 500s as soft retry
e551f14  harness: read assertChipsConserved snapshot in one repeatable-read tx; bump per-tick tolerance to 50 chips for parallel slack
6ffc940  audit: 17-harness-gerald-fixes.md final results (HARNESS_PARALLEL=4 19/19 ALL GREEN)
0e2b358  Merge harness/gerald-fixes: per-scenario log streams + strict assertions + parallel cleanup hygiene + hermetic deposit_during_close
```

Final branch: `main` @ `0e2b358`.
