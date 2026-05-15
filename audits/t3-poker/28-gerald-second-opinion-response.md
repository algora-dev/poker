# Gerald Second Opinion — Audit 28 Missing Cards / Eliminated UX
Date: 2026-05-15 | Auditor: Gerald | Scope: Dave brief `28-gerald-missing-cards-brief.md`

## Verdict
Dave's Bug A diagnosis is directionally right: this is a **client lifecycle ordering bug**, not bad DB hand state. I agree with fixing **both sides**:

1. Server: emit fresh `game:state` **after `initializeHand()` and before `game:new-hand`**.
2. Client: make `DealAnimation` fail-open by always calling `onComplete()` when it cannot run, plus add a `betweenHands` watchdog/escape hatch.

I would treat this as **High / Likely** because it can make one player's table look broken while the game continues and their timer/action UI remains live.

## Answers to Dave's questions

### Q1. Server-side order swap — yes, safe and preferable
Yes. I see no good reason for `game:new-hand` to fire before the personalized `game:state`.

Current evidence:
- `handLifecycle.ts` schedules next hand, then inside the timeout does:
  - `emitGameEvent(gameId, 'game:next-hand-chime', ...)`
  - `await initializeHand(gameId)`
  - `emitGameEvent(gameId, 'game:new-hand', ...)`
  - then `await broadcastGameState(...)`
- `GameRoom.tsx` handles `game:new-hand` by incrementing `dealTrigger`, while the state needed by `DealAnimation` comes from `game:state`.
- `DealAnimation.tsx:99-105` reads stale `playersRef.current`; if all players still look folded/eliminated it returns without `onComplete()`.

So the trigger is currently allowed to arrive before the data it depends on. Swap it.

One correction: the current `handLifecycle.ts` does `await broadcastGameState(...).catch(() => {})`; it is not fully fire-and-forget. But because it happens **after** `game:new-hand`, awaiting it does not help this race.

Recommended order:
1. `emitGameEvent(gameId, 'game:next-hand-chime', ...)`
2. `await initializeHand(gameId)`
3. read player ids
4. `await broadcastGameState(gameId, playerIds)`
5. `emitGameEvent(gameId, 'game:new-hand', { gameId, handId?: newHand.id })`

If Dave can cheaply include the new `hand.id` in `game:new-hand`, do it. It gives the client a real trigger key instead of a blind counter and improves debugging.

### Q2. UX timing — order swap should improve it, not break it
The correct UX is: countdown reaches zero → chime → backend creates new hand → client receives new hand state → `game:new-hand` starts the deal animation using fresh active seats/cards.

Fresh state before animation is exactly what we want. The user should not see cards immediately because `betweenHands` remains true until `DealAnimation.onComplete()`. The state can arrive first without exposing hole cards because `PokerTable.tsx` and `PokerTableMobile.tsx` both derive `hideCards = betweenHands || status !== 'in_progress'`.

Potential minor effect: if broadcast takes a few hundred ms, the deal animation starts a few hundred ms after the chime. That is acceptable and better than a permanent hidden-card state. If the pause is noticeable later, the fix is to make `game:new-hand` carry enough state/handId, not to trigger animation before state exists.

### Q3. Same-transaction race — no, not in the current helper shape
`initializeHand(gameId)` opens and awaits its own Prisma transaction when no `parentTx` is passed. When it returns, the hand/players/currentHandId writes are committed. A following `broadcastGameState()` read should see the new hand state.

I do not recommend a blind sleep/wait-for-visible loop here. If Dave wants belt-and-braces, do a bounded assertion instead:
- have `initializeHand()` return the new hand;
- before broadcasting, verify `game.currentHandId === newHand.id` or that `getGameState()` resolves to that hand;
- log and abort `game:new-hand` if not.

But with the current code, commit ordering is sufficient.

### Q4. Multi-instance / horizontal scale — yes, design client robust now
Yes. Even single-instance socket ordering does not protect against browser scheduling, reconnects, backgrounded tabs, missed events, or room/user-room split timing. The client must be robust to either order.

Minimum client hardening:
- `DealAnimation` empty-eligible branch must call `onCompleteRef.current?.()` before returning.
- Add a one-shot watchdog when `game:new-hand` arrives: if `betweenHands` is still true after ~4s, set it false.
- Clear the watchdog on successful `DealAnimation.onComplete()` and on unmount.
- Ideally trigger animation by `handId`/state readiness, not just event arrival. If `game:new-hand` arrives first, mark `pendingDealHandId`; when `game:state.currentHandId`/hand number changes and active players exist, fire the animation.

## Extra gotchas on Bug A

### 1. Mobile portrait may already have a permanent `betweenHands` risk
`GameRoom.tsx` only mounts `DealAnimation` on the oval/tablet-desktop path. In mobile portrait it renders `PokerTableMobile` directly and still passes `betweenHands`, but there is no `DealAnimation.onComplete()` to flip it false.

Evidence:
- `GameRoom.tsx:1079-1102` mounts `DealAnimation` only in the non-mobile branch.
- `PokerTableMobile.tsx:126-129` also hides cards when `betweenHands` is true.
- `setBetweenHands(false)` appears in showdown reveal and `DealAnimation.onComplete()`, not in the mobile `game:new-hand` path.

So Dave's 4s watchdog is not just belt-and-braces; it may be the thing that prevents mobile from getting stuck after any hand-end. If no mobile deal animation exists, mobile should either set `betweenHands(false)` on `game:new-hand` after fresh state arrives, or rely on the shared watchdog.

### 2. If server emits `game:state` before `game:new-hand`, don't let stale HTTP refresh overwrite it
`game:started` and some button handlers call `loadGameState()`. If a late HTTP response from the previous hand can land after socket `game:state`, it could still regress client state. I did not prove this is happening, but the client should avoid accepting older hand state once a newer hand id/hand number is known. Including `handId` or `handNumber` in state/events would make this easier.

### 3. Empty eligible should be a fail-open, not a silent no-op
Dave's proposed `onComplete()` call in the empty branch is correct. Also consider logging a lightweight client warning with `triggerKey`, player positions, and current hand id so this class is visible next time.

## Bug B — eliminated player misses showdown modal
I agree with Dave: remove the eliminated early-return.

Evidence:
- `GameRoom.tsx:789-807` returns the full-screen eliminated card whenever local player is eliminated and game is still in progress.
- That return happens before the table, fold-win modal, showdown modal, countdown overlays, and fast-forward reveal render.
- Grep found no other `EliminatedScreen` component/dependency; `PokerTable.tsx` and `PokerTableMobile.tsx` already know how to render eliminated seats and suppress action/pre-action buttons for eliminated players.

So the safer UX is: keep the table mounted, show eliminated status on the seat, suppress actions, and add a dismissible banner/toast with a leave button.

One caution: do not auto-call `handleLeaveGame()` on elimination. Leaving has game/accounting implications and currently asks for confirmation. Keep it user-triggered.

## Recommended patch order
1. Server order: `initializeHand` → `broadcastGameState` → `game:new-hand`.
2. `DealAnimation`: empty eligible → `setFlights(null)` + `onComplete()`.
3. `GameRoom`: watchdog to force `betweenHands(false)` if the animation path fails or is absent, especially mobile portrait.
4. Remove eliminated full-screen early return; replace with in-table banner/toast.
5. Add regression test or harness assertion: after `game:new-hand`, client must leave `betweenHands` within N seconds even if `game:state` and `game:new-hand` arrive in either order.

## Sign-off
I would sign off on Dave shipping Phase A immediately. For Phase B/C, I would require both the server order swap and client fail-open/watchdog. Either one alone reduces the bug; both together close the class properly.
