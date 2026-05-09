# Prompt for Gerald — Phase 10 re-audit (H-01 + H-03 + H-04)

Hey Gerald — Dave shipped the fixes you asked for in
`t3-poker-dave-h01-fix-prompt.md`. Branch is the same:
`fix/phase1-chip-accounting`, latest commit **`a247e0a`** (pushed).

Need a re-audit before this goes anywhere near production.

## Pull and read first

```bash
git fetch && git checkout fix/phase1-chip-accounting && git pull
git log --oneline 75cf680..HEAD
```

Two commits since your last audit:

1. `bd06a2a` — bot-driven harness + initial findings
2. `a247e0a` — Phase 10 fixes (this one)

Read in order:

1. `audits/t3-poker/11-harness-findings.md` — what the harness found (H-01, H-03, etc.)
2. `audits/t3-poker/12-phase10-h01-h03-h04-fixes.md` — what Dave changed and why

## Code surfaces to review

Core helpers (new files):

- `packages/backend/src/services/closeGame.ts`
- `packages/backend/src/services/activeGameLock.ts`

Call sites that now go through the helpers:

- `packages/backend/src/jobs/autoStartGames.ts` — cleanupFinishedGames + staleWaiting
- `packages/backend/src/services/admin.ts` — cleanupStuckGames + cancelGame
- `packages/backend/src/services/game.ts` — cancelGameBeforeStart
- `packages/backend/src/services/pokerActions.ts` — checkGameContinuation game-over branch
- `packages/backend/src/jobs/turnTimer.ts` — broadcastGameState after auto-action
- `packages/backend/src/services/withdrawal.ts` — pre-tx and in-tx active-game lock
- `packages/backend/src/blockchain/listener.ts` — credit-time lock check + park-for-review
- `packages/backend/src/api/wallet/index.ts` — /money-lock route + deposit-challenge lock + 409 mapping + check-authorization no longer leaks userId
- `packages/frontend/src/pages/Dashboard.tsx` — UX gate

## Reproduce the fixes for yourself

Local backend prereqs same as last time
(`HARNESS_BYPASS_GLOBAL_RATELIMIT=1` in `.env`, postgres up, backend running).

```bash
docker-compose up -d postgres
npm install
npm run --workspace=packages/backend migrate:dev
npm run dev:backend       # in another shell

export HARNESS_ADMIN_SECRET=<local backend's ADMIN_SECRET>
export HARNESS_BASE_URL=http://localhost:3000
```

Then run the three scenarios that exercise the fixes directly:

```bash
HARNESS_SCENARIO=action_timeout         npm run --workspace=packages/backend harness
HARNESS_SCENARIO=money_lock_active_game npm run --workspace=packages/backend harness
HARNESS_SCENARIO=eight_player_full_session npm run --workspace=packages/backend harness
```

Expected: all three PASS. `action_timeout` was the H-01 reproducer
(was printing +600 chips before, ledger now balances). `money_lock`
verifies the H-04 path end-to-end. `eight_player` exercises the
natural-completion close path under live concurrency.

You can also run the full battery — five of seven scenarios pass clean,
two are flaky on intermittent client-stall (NOT a chip-accounting issue
and NOT introduced by this branch — see "Known limits" below).

## Validation Dave already ran

- `tsc --noEmit`: clean
- `npm run test --workspace=packages/backend`: 11 files / 68 tests PASS
- Three scenarios above: PASS
- All six harness scenarios with the strict `assertClosedGamesAreEmpty`
  invariant on top — passes for the runs that complete

## What Dave would value your second opinion on

1. **closeGame helper shape**: is one helper with a discriminated `reason`
   the right call, or would you split into separate
   `cashoutOnGameOver` / `refundOnCancel` functions? Trade-off is a
   single audited path vs. clearer per-reason intent.
2. **Refund policy on cancel paths**: Dave settled on
   `chipStack + sum(current open hand contributions)` per player. Old
   admin code had a "split-pot equally if any actions were taken"
   heuristic — Dave dropped it because it could refund the wrong
   amount. Do you agree, or do you want the split policy back as an
   admin-only override?
3. **Parked deposits**: when a deposit confirms while the user is
   seated, Dave writes a `Deposit` row with `confirmed=false`, doesn't
   consume the auth, and logs `DEPOSIT_PARKED_FOR_REVIEW`. There's no
   admin endpoint yet to manually credit a parked row. Want one on
   this branch, or is logging-only enough for now?
4. **Money-lock fail-closed on the frontend**: if `/api/wallet/money-lock`
   itself errors, the UI treats the user as locked. Backend still
   enforces independently. OK or too aggressive?
5. **Operation naming**: `game_cashout` for natural end,
   `game_cancel_refund` for forced. Does that distinction help your
   dispute-tracing or does it muddy old `game_refund` audits from
   pre-Phase-10 rows?
6. **Anything else** you'd want changed before Shaun runs the testnet
   deposit/withdrawal gates and the 8-player live dev playtest.

## Known limits (deliberately not fixed on this branch)

- **Bot-client stalls under 8-handed concurrency**: harness sometimes
  sees a test bot stall on its turn for ~90s when state pushes race
  with action submission. Server-side concurrency check is correct
  (returns "Stale action — turn already advanced"). The bot test
  client doesn't always recover before the auto-fold timer cycle.
  Real frontend may need its own resilience pass — flagging as a
  follow-up. Not a chip-accounting issue.
- **Pre-existing showdown crash** in
  `src/services/sidePots.ts:63` — `TypeError: Cannot read properties
  of undefined (reading 'amount')` when `calculateSidePots` is invoked
  with no contributions (rare race where a hand reaches showdown with
  empty actions). Logged but not patched on this branch — predates
  Phase 10.
- **Stale-action 500 → 409** — you said defer, deferred.

## What's next if you sign off

1. Manual testnet deposit flow (your step 1 in `10-...`).
2. Manual testnet withdrawal flow (step 2).
3. 8-player live dev-preview playtest (step 3, partially automated by
   the harness already).
4. Merge to main and ship to dev.

Push back hard on anything off. Branch sits untouched until you're
happy.
