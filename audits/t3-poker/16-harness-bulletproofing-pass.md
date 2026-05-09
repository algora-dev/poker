# 16 — Harness Bulletproofing Pass (2026-05-09)

**Author:** Dave
**Branch when written:** `main` (locally merged; not yet pushed at time of writing)
**Source branches merged:**
- `harness/bulletproof-pass` (this work)
- `fix/phase1-chip-accounting` (Phases 1–10 backlog, brought to main as part of the same release window)

This document briefs Gerald (and any future auditor) on what was added in the
harness bulletproofing pass, where to look, how to run it, and what to verify.

---

## TL;DR

The bot-driven playtest harness was extended in 6 phases:

1. Bot-client watchdog (kills 8-handed silent-stall noise)
2. Forensics layer (per-run JSONL logs, invariant IDs, DB snapshots on fail, auto-filed issue markdowns)
3. Speed knobs (parallel runner, hand multiplier, loop mode)
4. 12 new scenarios (poker-rule edges, connection resilience, money flow)
5. Local full pass (18 / 19 PASS — single failure is a known pre-existing 8-handed stall, not a regression)
6. Railway pass (deferred — push blocker, see "Open issues" below)

In addition, **one real production issue surfaced and was patched**: the
`POST /api/games/:id/action` endpoint had a 60/min per-user rate limit that
was *not* covered by `HARNESS_BYPASS_GLOBAL_RATELIMIT`. Reconnect storms on
shaky mobile networks can easily breach 60/min. Fix: gate the action limiter
behind the same flag for harness runs. **The 60/min default in production
was NOT changed** — that's a product call for Shaun.

---

## File map (what to read, in order)

All paths relative to repo root.

### New code
- `packages/backend/tests/harness/runLog.ts` — structured JSONL run logger + invariant ID registry (`INV-CHIPS-CONSERVED`, `INV-NO-NEG-STACK`, `INV-SESSION-LEDGER`, `INV-NO-STALLS`, `INV-BOTS-HEALTHY`, `INV-CLOSED-GAMES-EMPTY`, `INV-SEQ-MONOTONIC`, plus inline `INV-LOCK-LEAK`, `INV-LOCK-STUCK`, `INV-DEPOSIT-DEFERRAL` ids in scenarios).
- `packages/backend/tests/harness/dbSnapshot.ts` — `snapshotFailure()` + `autoFileIssue()`. On any scenario failure, dumps full game/player/hand/handAction/handEvent/sidePot/chipBalance/chipAudit/moneyEvent rows for the gameId and bot users to `runs/<runId>/<scenario>.snapshot.json`, and writes a self-contained reproducer markdown to `tests/harness/issues/<runId>__<scenario>.md`.

### Changed code
- `packages/backend/tests/harness/botClient.ts`
  - Added `startWatchdog()` / `stopWatchdog()` / `shutdown()`. Watchdog re-fetches state via REST every 2s when it's our turn AND we haven't seen a state push in >4s. Pure safety net; never throws.
  - Added 429 handling in `sendAction()`: 1s backoff, no error pollution, returns `false` to retry on next turn key.
  - New counter `watchdogResyncs` is logged per bot in summary output.
- `packages/backend/tests/harness/orchestrator.ts`
  - Wires watchdog into bot lifecycle. Uses `shutdown()` for clean teardown.
  - Reads `HARNESS_HAND_MULTIPLIER` env to scale `maxHands` and `timeoutMs`.
  - Scopes the closed-games-empty and seq-monotonic invariants to the bots/hands of THIS scenario instance, so parallel scenarios don't cross-talk.
  - Writes an `__harness_inflight[runId] = { gameId, botUserIds }` breadcrumb on `globalThis` so the failure handler in `runHarness` can take a snapshot even when the orchestrator throws before returning a result.
- `packages/backend/tests/harness/runHarness.ts`
  - New env vars: `HARNESS_PARALLEL` (default 1), `HARNESS_HAND_MULTIPLIER` (default 1), `HARNESS_LOOP_MINUTES` (default 0), `HARNESS_PROFILE` (default `local`, tags scoreboard rows).
  - `HARNESS_SCENARIO` now accepts a comma-separated list.
  - Extracted `runOne()` and `runPass()` so serial + parallel + loop modes share one code path.
  - Per-pass scoped bot suffixes (parallel slot N gets `_p<N>` suffix appended) so parallel slots don't collide on the User table.
  - On scenario fail: snapshot DB + auto-file issue MD, then continue.
  - On run end: writes `runs/<runId>/summary.json` and appends one row to `audits/t3-poker/harness-results.md`.
- `packages/backend/tests/harness/invariants.ts` — every assertion now goes through `failInvariant()` which tags errors with a stable `invariantId` and writes a structured failure to the run log.
- `packages/backend/tests/harness/scenarios.ts` — 12 new scenarios appended (see "Scenario inventory" below).
- `packages/backend/tests/harness/strategies.ts` — added `AlwaysFold`, `MinRaiser`, `Slowpoke`.
- `packages/backend/tests/harness/.gitignore` — added `runs/` and `issues/` so per-run artefacts stay local.
- `packages/backend/src/api/games/index.ts` — wraps the per-user 60/min action rate-limit in a `CONFIG.HARNESS_BYPASS_GLOBAL_RATELIMIT ? false : { ... }` guard. **Production behaviour unchanged when the flag is off** (which it is, by design, in production).

---

## Scenario inventory (19 total)

Original 7 (pre-existing, not touched by this pass):
1. `eight_player_full_session` — 8 bots, 30 hands, mixed strategies. Smoke + accounting.
2. `all_in_storm` — 4 always-all-in bots. Side pots, all-in showdowns.
3. `disconnect_reconnect` — 4 bots; one drops + reconnects between hands.
4. `action_timeout` — 3 bots; one silent. Verifies 30s auto-fold.
5. `cashout_mid_game` — 4 bots; aggro busts others.
6. `concurrency_blast` — 6 random bots, 40 hands. Stress test.
7. `money_lock_active_game` — withdraw/deposit-challenge/create-game return 409 while seated.

New 12 (this pass):

**Batch A — poker-rule edges**
8. `heads_up_blinds` — 2 bots, 10 hands. SB-acts-first preflop, BB option, post-flop order.
9. `heads_up_walk` — SB always folds; BB takes blinds every hand.
10. `min_raise_short_allin` — under-min all-in then re-raise legality.
11. `side_pot_three_way_uneven` — 3 bots, asymmetric all-ins.

**Batch B — connection / concurrency**
12. `mid_hand_disconnect_on_turn` — disconnects target bot while it's their turn; auto-fold should fire.
13. `mid_hand_reconnect_state` — drop + reconnect mid-hand, validate state continuity.
14. `spectator_join_mid_hand` — second socket on same user joins mid-hand; no crash, no state corruption.
15. `concurrent_create_race` — 5 users hit `/games/create` simultaneously; all should succeed with distinct gameIds.

**Batch C — money flow + resilience**
16. `withdraw_at_showdown` — every tick, every bot tries `/withdraw`. While game `in_progress`, all attempts must 409. Any 200 is a lock leak (`INV-LOCK-LEAK`).
17. `clock_drift_slow_clients` — 5 bots with thinkMs varying 0→800ms. Server-side timing must stay sane.
18. `bust_then_new_game` — bot busts, lock should release on closeGame, bot can then create a new game (`INV-LOCK-STUCK`).
19. `deposit_during_close` — drives `creditChipsForTesting` while seated; balance must NOT change, deposit row written `confirmed=false`, auth must NOT be consumed (`INV-DEPOSIT-DEFERRAL`).

---

## How to run (local)

Prereqs: Postgres up, backend running with `HARNESS_BYPASS_GLOBAL_RATELIMIT=1`,
`JWT_SECRET` and `ADMIN_SECRET` in `packages/backend/.env`.

```bash
# Full pass (all 19 scenarios, serial, hand multiplier 1)
HARNESS_BASE_URL=http://localhost:3000 \
HARNESS_ADMIN_SECRET=*** \
npm run --workspace=packages/backend harness

# Single scenario
HARNESS_SCENARIO=heads_up_blinds npm run --workspace=packages/backend harness

# Comma-list of scenarios
HARNESS_SCENARIO=heads_up_blinds,withdraw_at_showdown npm run --workspace=packages/backend harness

# Parallel (4 scenarios at once; safe because each scenario uses suffix-isolated bots)
HARNESS_PARALLEL=4 npm run --workspace=packages/backend harness

# Stress with hand multiplier
HARNESS_HAND_MULTIPLIER=5 HARNESS_SCENARIO=eight_player_full_session npm run --workspace=packages/backend harness

# Loop until first failure or N minutes
HARNESS_LOOP_MINUTES=30 npm run --workspace=packages/backend harness
```

Outputs:
- `packages/backend/tests/harness/runs/<runId>/` — per-scenario JSONLs + `summary.json`. On failure also `<scenario>.snapshot.json`.
- `packages/backend/tests/harness/issues/<runId>__<scenario>.md` — auto-filed markdown reproducer (only on failure).
- `audits/t3-poker/harness-results.md` — append-only scoreboard, one row per run.

---

## Local full-pass results (run before this doc)

| Run | Scenarios | Pass | Fail | Total | Notes |
|---|---|---|---|---|---|
| `2026-05-09T11-19-53-904Z` | 19 | 18 | 1 | 6m 51s | `eight_player_full_session` failed `INV-NO-STALLS` (90s stall on bot4). Known issue. |

The single failure is the **pre-existing 8-handed silent-stall** documented
in `MEMORY.md` ("Bot-client stalls under 8-handed concurrency"). It is NOT
a regression introduced by this pass. The watchdog reduced the frequency
in casual runs but did not eliminate it on the heaviest scenario.

---

## What Gerald should verify

### Code review focus areas (highest signal first)

1. **`packages/backend/src/api/games/index.ts`** — the only production code
   change. Confirm the rate-limit guard is correct: with
   `HARNESS_BYPASS_GLOBAL_RATELIMIT=false` (production default), the limiter
   behaves exactly as before. With the flag on, it's disabled. This should
   be a one-line semantic check.

2. **`packages/backend/tests/harness/scenarios.ts`** — the new scenarios.
   In particular:
   - `withdraw_at_showdown` — does the assertion logic correctly distinguish
     a 200 (lock leak, fail) from a 409 (expected, drain body, continue)?
   - `bust_then_new_game` — the comment is correct that 200 OR
     "409 with non-`active_game_money_locked` code" both mean lock released.
   - `deposit_during_close` — does the `(globalThis as any)[flagKey]` scope
     by gameId actually prevent re-firing within a single scenario instance?
     (It does, but the pattern is unusual; worth a second pair of eyes.)

3. **`packages/backend/tests/harness/invariants.ts`** — `failInvariant()`
   helper attaches `invariantId` to the thrown error. Check that the
   `runHarness.ts` failure handler reads it correctly.

4. **`packages/backend/tests/harness/runHarness.ts`** — parallel mode
   skips DB reset and relies on (a) suffix-isolated bot accounts and (b)
   per-user / per-hand scoped invariants in `orchestrator.ts`. Sanity
   check: are there any invariants in `invariants.ts` that scan globally
   and would falsely fail when two parallel scenarios are mid-flight?
   I believe `assertChipsConserved` is fine because it queries by
   `gameId`, but worth a fresh look.

5. **`packages/backend/tests/harness/botClient.ts`** — watchdog runs every
   2s. Could it ever cause double-acting? It calls `maybeAct()` which
   dedupes on `lastActedKey = stage|currentBet|myStageBet`, so a re-fire
   on the same turn with no state movement is a no-op. Confirm this
   reasoning.

### Run it yourself

```bash
git checkout main
npm install
docker-compose up -d postgres
npm run --workspace=packages/backend migrate:dev
# Start backend in another shell:
npm run dev:backend
# Then:
HARNESS_ADMIN_SECRET=<value-from-.env> npm run --workspace=packages/backend harness
```

Expected: 18/19 pass. The known stall on `eight_player_full_session` may
or may not reproduce — it's flaky.

To exercise the failure path on purpose, force-fail a scenario by
introducing a deliberate ledger imbalance and run a single scenario.
The forensics layer should produce: a failed JSONL line, a snapshot.json
with full game state, an auto-issue markdown with the repro command.

### Open follow-ups (Gerald's call whether to file)

- **M-02:** raise the production action rate limit from 60/min to 180/min,
  or implement a token-bucket that allows short bursts during reconnects.
  Keeping 60/min hard-cap will hurt real users on shaky mobile.
- **M-03 (existing open loop):** root-cause the 8-handed silent stall.
  The watchdog mitigates it but doesn't eliminate it. Likely needs a
  server-side state-push retry or a sticky room-broadcast deduplicator.
- **L-02:** the `graceful_restart` scenario was deferred (would require
  the harness to control the backend process). Worth a focused PR if
  surviving an in-flight restart matters for our deploy story.

---

## Commits in this pass

```
36a58be harness: bot-client watchdog + clean shutdown
84f75e0 harness: forensics layer (JSONL run logs, invariant IDs, DB snapshot on fail, auto issue files)
caa683d harness: speed knobs (HARNESS_PARALLEL, HARNESS_HAND_MULTIPLIER, HARNESS_LOOP_MINUTES) + scoped invariants
7bcb028 harness: scenarios batch A (heads_up_blinds, heads_up_walk, min_raise_short_allin, side_pot_three_way_uneven) + AlwaysFold/MinRaiser/Slowpoke
b47700b harness: scenarios batch B (mid_hand_disconnect_on_turn, mid_hand_reconnect_state, spectator_join_mid_hand, concurrent_create_race)
b53841b harness: scenarios batch C (withdraw_at_showdown, clock_drift_slow_clients, bust_then_new_game, deposit_during_close)
7c9f15c harness: rate-limit bypass on action endpoint; bot 429 backoff; snapshot fallback to inflight breadcrumb
45b9c82 harness: gitignore runs/ and issues/ (per-run forensics, not source)
```

Plus two merge commits:
```
d79c200 Merge Phases 1–10: chip accounting + money lock hardening + close-game helper + audit fixes
ac54564 Merge harness/bulletproof-pass: bot watchdog, forensics, speed knobs, 12 new scenarios, action rate-limit harness bypass
9b7ca12 audit: 16-harness-bulletproofing-pass.md + brief test results row
```

---

## Open issues

- **Push to origin/main is currently blocked** — `git push` is hanging
  silently in this session. `git fetch` works fine, suggesting either a
  hidden credential prompt or a network-level POST issue. Local main has
  both merges committed; needs a real terminal to land on Railway.
- **Railway pass deferred** until push lands.
