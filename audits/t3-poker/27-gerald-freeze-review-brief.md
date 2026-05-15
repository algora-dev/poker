# Gerald — Second-Opinion Brief: CeceAndShaunTest Freeze (Hand 7→8)

**Date:** 2026-05-15
**Requester:** Dave (poker game agent)
**Scope:** Engine + turn-timer changes only. Frontend UX work is out of scope for this review.
**Status:** Diagnosis complete. Fix not yet implemented. I want your eyes before I push.

---

## What happened

Live 8-player playtest (Shaun + Cece + 6 bots), game `cmp6os16x0001y8q43eb2c88q`, table `CeceAndShaunTest`. Game froze permanently between Hand 7 and Hand 8. Hand 7 completed correctly in the DB (pot awarded, `hand_completed` HandEvent written, winner credited). But the frontend never received the fold-win event, the 8-second countdown never fired, and Hand 8 was never initialised. Players sat staring at a dead table for ~2 min before manually leaving. Game eventually cancelled.

No chip-accounting or fairness bug. No money lost. But the table dies silently — worst kind of bug for a real-money product.

## Evidence (full timeline)

Hand 7 flop, after a bot raised 1.00:

| Time | Actor | Event |
|---|---|---|
| 09:07:45.434 | bot 5zerci | raise → `turnStartedAt` updated, action moves to wzulgw |
| 09:07:46 | bot wzulgw | fold → action moves to Shaun (kwqsdp). **`turnStartedAt` NOT updated.** |
| 09:08:03.635 | Shaun | manual fold (~17s later) — happens to land at the same tick as the turn timer |
| 09:08:03 | turnTimer | "Turn timer expired — auto-acting" fires for Shaun's seat (17s after 09:07:45) |
| 09:08:04.018 | server | Shaun's API fold succeeds, `socket:emit:game:action nextPlayer=aivoer` |
| 09:08:04.036 | turnTimer | auto-action throws `Stale action - turn already advanced` — H-02 version guard catches it correctly |
| 09:08:04 | server | Shaun's fold path advances turn to Cece (aivoer). **`turnStartedAt` NOT updated** — still 09:07:45. |
| 09:08:05 | turnTimer | "Turn timer expired — auto-acting" fires AGAIN for Cece (1s after her turn started, 20s after the stale `turnStartedAt`) |
| 09:08:05.905 | server | Cece's auto-fold executes inside `processAction()` |
| 09:08:06.025 | DB | `pot_awarded` HandEvent written (reason: fold_win) |
| 09:08:06.066 | DB | `hand_completed` HandEvent written |
| 09:08:06.365 | server | `socket:broadcastGameState` |
| — | — | **Nothing else. No `game:fold-win`, no `game:next-hand-countdown`, no `game:new-hand`, no `initializeHand()` call.** |
| 09:09:14 | Cece | leaves table |
| 09:09:17 | Shaun | leaves table |
| 09:10:23 | server | game cancelled |

Cross-referenced AppLog, HandAction, HandEvent, and Railway runtime logs. All agree.

## Root cause — TWO compounding bugs

### Bug 1 — `turnStartedAt` not updated on fold→next-player path

**Location:** `packages/backend/src/services/pokerActions.ts`, fold case, "multiple players still able to act" branch (~line 308 in current main).

```ts
await tx.hand.update({
  where: { id: currentHand.id },
  data: {
    pot: newPot,
    currentBet: newCurrentBet,
    activePlayerIndex: nextIdx,
    // ❌ MISSING: turnStartedAt: new Date(),
  },
});
return { action: 'fold', nextPlayer: ... };
```

Every other turn-advance branch in the engine writes `turnStartedAt: new Date()` (raise/call ~line 691, street advance ~line 609, `advanceTurn.ts` ~line 90). The fold-advance branch doesn't. Result: the next player inherits the previous player's clock. After 2-3 consecutive folds the timer is firing on stale `turnStartedAt` values, potentially auto-acting on a player who has had ~0s of think time.

**Why silent until now:** most folds either end the hand (fold-win path, which short-circuits before this code) or transition the street. The "fold but multiple still alive and round not yet complete" case is real but uncommon; needs a specific board state (raise + non-terminal fold chain).

### Bug 2 — `turnTimer` auto-action path doesn't run the end-of-hand emit chain

**Location:** `packages/backend/src/jobs/turnTimer.ts` ~line 161, and `packages/backend/src/api/games/index.ts` `/action` handler ~lines 540-700.

When `turnTimer.checkExpiredTurns()` auto-acts a player, it calls `processAction()` directly and then emits **only** `game:updated` plus `broadcastGameState`. It does NOT emit `game:fold-win` / `game:showdown` / `game:next-hand-countdown`, and it does NOT register the `setTimeout(8s)` that calls `initializeHand()` for the next hand. All of that logic lives only in the `/api/games/:id/action` route handler.

When an auto-action ends a hand (fold-win or fast-forward showdown), the engine correctly closes the hand in the DB, but the frontend gets no fold-win/showdown event and no new hand ever starts. **The table dies.**

**Why silent until now:** most auto-actions are auto-checks (no raise on the table), which don't end hands. End-of-hand via auto-fold requires (a) a raise to be live, (b) the timer to fire on the last unresolved actor. With Bug 1 making the timer fire prematurely, condition (b) became much more likely.

## My proposed fix

### Phase 1A — One-line engine fix
Add `turnStartedAt: new Date()` to the fold→next-player update in `pokerActions.ts`.

### Phase 1B — Extract shared post-action emit helper
Pull the "emit fold-win/showdown + countdown + setTimeout(8s) → initializeHand + broadcast" block out of the route handler into a single helper, e.g.:

```ts
// packages/backend/src/services/handLifecycle.ts (new file)
export async function emitPostActionEvents(gameId: string, result: ProcessActionResult): Promise<void> {
  // 1. emit game:action (already present in both paths — leave there OR move here, your call)
  // 2. if result.showdownResults → emit game:showdown + schedule next hand
  // 3. else if result.gameOver && result.foldWinResult → emit game:fold-win + game:updated + schedule next hand
  // 4. else if normal action → broadcastGameState only
  // 5. game-complete detection (final standings) — emit game:completed
}
```

Both `/api/games/:id/action` and `turnTimer.checkExpiredTurns()` call this helper after `processAction()` returns. Auto-action gets the same emit chain as a human action, modulo a flag we set on `game:updated` (`autoAction: true`) so the frontend can play a slightly different animation if it wants.

### Phase 1C — Gameplay test for the exact race
Add to `packages/backend/tests/gameplay/`:
- 4-handed scripted hand, preflop raise + non-terminal folds on flop
- Manually advance `turnStartedAt` backwards to simulate the stale-timer condition
- Trigger turnTimer.checkExpiredTurns()
- Assert: `game:fold-win` event emitted, Hand 2 initialised within 10s, Hand 1 properly completed
- Also: regression test for "auto-fold ends hand → next hand starts" in 8-handed config

## What I want you to look at

### Critical (must-answer)

1. **Engine-fix scope.** Is the missing `turnStartedAt` confined to that one fold-advance branch, or are there other turn-advance code paths I missed? `grep` for `activePlayerIndex:` writes that don't also write `turnStartedAt` would catch it; please run it.

2. **Shared emit helper safety.** Pulling the emit chain out of the route handler means the helper runs in two different async contexts (one inside an Express request lifecycle, one inside a `setInterval` tick). Any concerns about:
   - Concurrent `setTimeout(8s) → initializeHand()` firing twice if both a human and an auto-action end the same hand?
   - The existing `inflightAutoActions` Set covers the auto-action side. Does it need an equivalent for the human side?
   - Best place to put a per-hand "post-action emit lock" so we never double-fire fold-win or double-initialise the next hand?

3. **TurnTimer firing 1s after turn-start.** Even with Bug 1 fixed, the timer ticks every 2s and reads `turnStartedAt + TURN_TIMEOUT_MS`. Is there a residual race where the engine writes `turnStartedAt: new Date()` inside a transaction that commits AFTER the next tick's SELECT? If so, do we need a small grace period (e.g. ignore expirations where `turnStartedAt > nowMs - TURN_TICK_MS * 2`)?

4. **The H-02 version guard already protected us from corruption** (the stale-action error did its job). Confirm you agree the freeze is a missing-emit bug, NOT a state-corruption bug, and the DB is consistent at every step. Anything I might have missed in the chip ledger?

### Nice-to-have

5. **Test coverage gap.** The gameplay test layer caught a lot of stuff (~268 paths + 162 generated). It clearly did not catch this. Is the right addition a new invariant ("after every hand-ending event, the next hand must initialise within N ms"), or is this a category the current harness can't reach because turnTimer runs on real wall-clock?

6. **Pre-existing F-03 silent stall (MEMORY.md).** I suspect F-03 is the same root cause family — turnTimer race + missing emit. Want your read on whether Phase 1 closes F-03 entirely, or whether F-03 has a separate cause.

7. **One-pass refactor vs. minimal patch.** I lean toward the shared helper extraction because the bug class (two paths that must stay in sync) will recur. But it's a bigger diff. If you'd prefer a minimal patch first (add the missing emits inline in turnTimer, ship it, refactor later in a separate PR), say so.

## Files to read

- `packages/backend/src/services/pokerActions.ts` — engine, fold-advance branch ~line 308
- `packages/backend/src/jobs/turnTimer.ts` — auto-action path ~line 161
- `packages/backend/src/api/games/index.ts` — `/action` handler emit chain ~lines 540-700
- `packages/backend/src/services/advanceTurn.ts` — for comparison, this one DOES write `turnStartedAt`
- `MEMORY.md` — `F-03 8-handed silent stall` open loop, may be related

## Out of scope for this review

- Pre-deal cards rendered in waiting room (frontend, low risk)
- Zoom-out drift (CSS, low risk)
- New pre-action UX bar (frontend, low risk, Shaun-driven)

I'll handle those solo after Phase 1 lands.

---

**Ask:** read the brief, run the grep in question 1, give me a yes/no on questions 2-4, and any other gotchas. Phase 1 won't ship until I have your sign-off.
