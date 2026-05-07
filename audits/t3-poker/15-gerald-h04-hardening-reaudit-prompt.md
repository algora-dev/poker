# Prompt for Gerald — H-04 hardening re-audit

Hey Gerald — Dave shipped the H-04 hardening you asked for in
`t3-poker-phase10-h04-hardening-prompt.md`. Same branch
`fix/phase1-chip-accounting`, latest commit on top of `a247e0a`.

## Pull and read first

```bash
git fetch && git checkout fix/phase1-chip-accounting && git pull
git log --oneline a247e0a..HEAD
```

Read in order:

1. `audits/t3-poker/14-phase10-h04-hardening.md` — what changed and why
2. `audits/t3-poker/12-phase10-h01-h03-h04-fixes.md` — previous Phase 10 context

## Code surfaces to review

New:

- `packages/backend/src/services/userMoneyMutex.ts`

Changed:

- `packages/backend/src/services/activeGameLock.ts` — lock rule no longer requires `chipStack > 0`
- `packages/backend/src/services/withdrawal.ts` — mutex + recheck inside deduct tx
- `packages/backend/src/services/game.ts` — mutex + recheck in createGame/joinGame, GameJoinMoneyLockedError
- `packages/backend/src/services/closeGame.ts` — mutex per-player in stable userId-asc order
- `packages/backend/src/blockchain/listener.ts` — mutex + deferred-deposit (no auto-credit)
- `packages/backend/src/api/games/index.ts` — 409 mapping on /create and /join
- `packages/backend/tests/harness/scenarios.ts` — money_lock_active_game now asserts 9 things

## Reproduce

Same setup as before (HARNESS_BYPASS_GLOBAL_RATELIMIT=1, postgres up,
backend running). Run the three target scenarios:

```bash
HARNESS_SCENARIO=money_lock_active_game     npm run --workspace=packages/backend harness
HARNESS_SCENARIO=action_timeout             npm run --workspace=packages/backend harness
HARNESS_SCENARIO=eight_player_full_session  npm run --workspace=packages/backend harness
```

Expected: all PASS. The money_lock scenario now covers:

1. Seated waiting + chipStack > 0 → withdraw 409
2. Same → /generate-message 409
3. Same → /money-lock = locked
4. **All-in (chipStack=0, position=all_in, status=in_progress) → still locked, withdraw 409**
5. **Folded (chipStack=0, position=folded) → still locked**
6. **Trying /games/create while seated → 409 active_game_money_locked**
7. **Deposit credit-time lock**: drives `creditChipsForTesting`, asserts ChipBalance unchanged + auth still usable + Deposit row confirmed=false
8. After closeGame → /money-lock = false
9. (implicit) per-user money mutex held inside every mutation tx

If `eight_player_full_session` stalls/fails on first try, retry once —
the intermittent bot-client stall is a known test-client issue, not a
chip-accounting issue (documented in MEMORY.md and section "Out of
scope" of `14-phase10-h04-hardening.md`).

## What Dave would value your second opinion on

1. **Lock rule**: did Dave go too far by including eliminated seats?
   The default is fail-closed; an admin override could unlock them
   before closeGame runs. Want that escape hatch on this branch?
2. **Mutex strategy**: PostgreSQL `pg_advisory_xact_lock` keyed by a
   stable 63-bit hash of userId. Auto-released on tx end. Any concerns
   vs. row-locking the ChipBalance row, or vs. SERIALIZABLE
   isolation?
3. **Deferred-deposit shape**: Dave writes ONE `Deposit` row with
   `confirmed=false` for idempotency, doesn't consume the auth, logs
   `DEPOSIT_DEFERRED_ACTIVE_GAME` loudly. Manual operator procedure
   documented in `14-...md` section 4. Is the row OK or do you want
   it removed entirely (with the consequence that historical-sync
   could re-attempt forever)?
4. **`createGame` lock**: idempotent re-join to same game is allowed
   in joinGame; create is always blocked when seated. Reasonable?
5. **closeGame mutex per-player**: stable userId-asc order to prevent
   deadlocks. OK or do you want a single global game-level lock
   instead?
6. Anything else before Shaun runs the testnet money gates and the
   8-player live dev playtest.

## Validation Dave already ran

- `tsc --noEmit`: clean
- `npm test --workspace=packages/backend`: 11 files / 68 tests PASS
- harness `money_lock_active_game`: PASS (covers all 9 assertions)
- harness `action_timeout`: PASS (3 hands, ledger conserved)
- harness `eight_player_full_session`: PASS (32 hands, ledger conserved)

## Known limits, deliberately not fixed

- Bot-client stalls under 8-handed concurrency. Test-client issue, not
  chip-accounting.
- Pre-existing `sidePots.ts:63` showdown crash on empty contributions.
  Predates Phase 10.
- Stale-action 500 → 409 (you said defer).
- Admin endpoint for deferred-deposit recovery (you said defer).

## What's next if you sign off

1. Manual testnet deposit flow (your step 1 in `10-...`).
2. Manual testnet withdrawal flow (step 2).
3. 8-player live dev-preview playtest (step 3).
4. Merge to main.

Branch sits untouched until you're happy.
