# Gerald Second Opinion — CeceAndShaunTest Freeze Review
Date: 2026-05-15 | Auditor: Gerald | Scope: Dave brief `27-gerald-freeze-review-brief.md`

## Verdict
Dave's diagnosis is correct: this is a **missing lifecycle emit/schedule bug triggered by a stale turn clock**, not a chip-accounting or DB-corruption bug.

I would approve Phase 1 with one condition: **do not just copy/paste emits into `turnTimer`; centralise the post-action lifecycle and add a per-completed-hand dedupe/claim around countdown/new-hand scheduling.**

## Answers to Dave's must-answer questions

### 1. Engine-fix scope — mostly yes
I checked `activePlayerIndex` writes across the named files.

Confirmed missing clock reset:
- `packages/backend/src/services/pokerActions.ts:312` — fold → next-player branch writes `activePlayerIndex: nextIdx` but does **not** write `turnStartedAt`.

Other relevant turn-advance paths already reset the clock:
- `pokerActions.ts:608-609` — street advance sets `activePlayerIndex` + `turnStartedAt`.
- `pokerActions.ts:690-691` — normal next-player branch sets both.
- `pokerActions.ts:1340-1341` — shared `settlePostAction` street advance sets both.
- `advanceTurn.ts:89-90` — dead-seat/leave helper sets both.
- `holdemGame.ts:107-112` — new hand creation sets `turnStartedAt`.

So the one-line fix is valid for the specific stale-clock bug. Terminal fast-forward/showdown/fold-win updates that do not set `activePlayerIndex` do not need a new `turnStartedAt`.

### 2. Shared emit helper safety — yes, but add a lifecycle lock
I agree with extracting a shared helper. The current split is dangerous:
- API route emits `game:showdown`, `game:fold-win`, `game:next-hand-countdown`, schedules `initializeHand()`, emits `game:new-hand`, and emits `game:completed`.
- `turnTimer.ts:160-172` calls `processAction()` then only emits `game:updated` and broadcasts state.

That means any timer action that ends a hand can correctly complete DB state but never start the next hand.

Caveat: `inflightAutoActions` only protects the auto-action execution path. It does **not** protect lifecycle side effects after `processAction()` returns, and it does nothing for human request lifecycle scheduling.

Recommended shape:
- Put the helper in one service, called by both API and timer.
- Key lifecycle dedupe by completed `handId`, not just `gameId`.
- Add a process-local `scheduledNextHands` Set now, because Railway appears single-instance.
- Before the 8s timeout calls `initializeHand()`, re-read the game and confirm:
  - game still `in_progress`
  - `game.currentHandId` is still the completed hand being advanced from
  - no non-completed hand already exists for the game
- Longer-term / scale-safe: replace process-local dedupe with a DB claim/advisory lock or persisted `nextHandScheduledAt`/transition state. `initializeHand()` is not idempotent today; schema has only indexes on `gameId`/`handNumber`, not a unique active-hand guard.

Important: the helper should also emit `game:action` for auto-actions. The timer currently emits only `game:updated`, so clients miss the same action animation/data path that human actions get.

### 3. Residual 1s timer race — no blocker after Bug 1
I do **not** think a committed-new-turn / next-tick SELECT race can auto-fold the new actor after ~1s once the fold branch writes `turnStartedAt: new Date()`.

Reason: if the timer SELECT runs before the transaction commits, it sees the old hand state and attempts the old actor. H-02/version guard rejects that as stale. If it sees the committed new actor, it also sees the fresh `turnStartedAt`, so it should not match the expiry query.

A small grace window is acceptable as belt-and-braces, but I would not make it the primary fix. The primary fix is: every turn handoff must reset `turnStartedAt`, and every stale action must continue to be rejected.

### 4. State corruption / chip ledger — agree: no evidence of corruption
I agree this freeze is not chip corruption.

Evidence from code:
- `handleFoldWin()` increments only the winner's in-table `GamePlayer.chipStack`, marks the hand `completed`, writes `pot_awarded` and `hand_completed`, then runs `checkGameContinuation()`.
- No off-table balance credit happens on hand win, which matches the earlier chip-accounting fix policy.
- H-02 should reject the duplicate Shaun timer action after Shaun's manual fold moved the version.

So: DB state can be internally consistent while the UI/table lifecycle is dead because the timer path omitted the fold-win/showdown/countdown/new-hand event chain.

## Nice-to-have answers / gotchas

### 5. Test coverage gap
Add both:
1. A direct regression: auto-fold ends hand → `game:fold-win` emitted → countdown scheduled → next hand initialised.
2. A broader invariant: **if a hand reaches `completed` while game remains `in_progress`, exactly one next-hand lifecycle is scheduled and exactly one new hand is created.**

The current harness likely missed it because `turnTimer` is wall-clock/setInterval driven and `checkExpiredTurns()` is not exported/injected. Make the timer/lifecycle testable with fake timers and socket spies.

### 6. F-03 silent stall
Phase 1 likely closes this exact Hand 7→8 freeze and probably part of F-03's root-cause family. I would **not** mark F-03 fully closed yet.

Reason: `advanceDeadActiveSeats()` still only advances dead folded/eliminated active seats. If no active seat remains, it returns without forcing showdown/fold-win. It also skips `all_in` active seats. If any prior path leaves `activePlayerIndex` on a dead/all-in/no-actor state, a different silent stall is still possible.

So close F-03 only after a replay/invariant pass proves every terminal/near-terminal hand state either settles or advances.

### 7. One-pass refactor vs minimal patch
Recommendation: **small shared helper now**, not copy/paste inline timer emits.

Minimal safe Phase 1:
- Add `turnStartedAt: new Date()` to fold → next-player branch.
- Extract shared post-action lifecycle helper for API + timer.
- Add per-hand lifecycle dedupe before scheduling `initializeHand()`.
- Add targeted regression tests.

Do not expand this into a broad gameplay refactor. Keep it surgical, but centralise the duplicated lifecycle because this exact bug class will recur otherwise.

## Sign-off
I would sign off on Dave implementing Phase 1 **with the lifecycle dedupe/claim included**. Without that, shared helper extraction fixes the missing emit but leaves a credible double-countdown/double-initialise risk.
