# Gerald brief — CeceShaunV3 multi-bug investigation

**Status:** multiple bugs reported by Shaun after a 24-hand playtest (`CeceShaunV3`, game id `cmp5w12ai030wdwtun4cd4q3k`, played 2026-05-14 19:34-19:51 UTC). I've investigated every issue against the live DB (HandAction, HandEvent, Game, GamePlayer tables) and against the source. Some are confirmed real bugs, some are correct engine behaviour with bad UX, some are scope-and-config issues.

**Ask:** sanity check my proposed fixes — especially **Issue C (lap bug)** because it's the only one with real fairness implications and the fix touches `processAction` which has burned us with subtle regressions before. Also tell me if my plan for **Issues D/E (cards visible before deal anim)** is the right approach or if you can see something I'm missing.

The fixes are split into 3 commits, ordered by priority/blast radius. Commit 1 is the production-fairness fix and is the one I most want a second opinion on. Commits 2 and 3 are lower-risk.

---

## Tooling used to investigate

Wrote two Node scripts (cleaned up after this session):

- `debug-ceceshaunv3.mjs` — pulled all 24 hands + every HandAction; detected the lap pattern algorithmically (a player acting more than once on a street with no aggression in between, excluding blinds and BB option); dumped blind sizes per hand to confirm escalation.
- `debug-ceceshaunv3-lap.mjs` — drilled into the 4 suspect hands with full action timelines.

I also pulled the full HandEvent audit trail for Hand 3 (the "pocket 9s auto-played" hand Shaun flagged) and Hand 14 (the only other large pot worth checking).

---

## Issue C — Lap bug (player acts twice on a street): **CONFIRMED REAL**

### Evidence

4 of 24 hands (~17%) had a player record a second action on the same street, with no aggression between their first and second action.

Example — **Hand 9 flop** (raw HandAction timeline):

```
e06   check    0.00
test  check    0.00
bd9   RAISE    1.00      ← bd9 is the aggressor
e06   call     1.00
test  fold     0.00      ← test's fold completes the street
bd9   check    0.00      ← BUG: bd9 acts again, ~6s after test's fold
```

Same pattern in Hand 1 flop (bot_f06 raises → 3 callers → 1 folder → bot_f06 "checks" again), Hand 4 river (bot_bd9 raises → call → fold → bot_bd9 "checks" again), Hand 6 flop (test10speed raises → call → fold → test10speed "checks" again).

In every case the second action is a no-op `check` with `amount=0`, ~5-10 seconds after the fold that should have ended the street.

### Root cause (read-and-traced from source)

`packages/backend/src/services/pokerActions.ts`, the `fold` case in the `processAction` switch (line ~99 onwards).

The fold handler:
1. Marks the player folded
2. Records the fold action
3. Refetches players from DB
4. Checks `remainingActive.length === 1` → fold-win
5. Checks `remainingNonAllIn.length <= 1` → fast-forward showdown
6. **Otherwise, advances `activePlayerIndex` to the next active player and returns.**

Step 6 never calls `checkBettingComplete`. The handler assumes that if there are ≥2 remaining active non-all-in players, someone must still owe an action. **That assumption is wrong** when the folding player was the last unresolved actor on the current street.

Every OTHER action path (check / call / raise / all-in) calls `checkBettingComplete` after applying the action (around line 504). The fold path is the only one that skips it.

### Why it usually doesn't break the game

The "extra check" is a true no-op:
- `amount: 0`, no chip movement
- All bets already matched at the high-water mark
- `checkBettingComplete` after the no-op correctly returns true → street advances normally

So pots end up correct, hands complete correctly, ledger is internally consistent. We've shipped the game with this bug since launch and not noticed.

### Why it's still a real production bug

1. **Fairness:** the prior aggressor sees the full action of the street (everyone called or folded) and is then prompted to act AGAIN. They could choose to *raise* instead of checking — re-opening action on themselves with full info advantage over the field. Shaun specifically called this out as "if playing for real money, this is unfair". He's right. The fact that bots happen to send `check` doesn't make the engine correct — a malicious or just opportunistic human will eventually try the raise.
2. **UX:** ~6 second pause between when the action visually finishes and when the next street appears, while the engine waits for a phantom actor.
3. **Auditability:** HandAction contains phantom no-op rows that aren't legitimate poker play. Hard to reconcile if we ever need to audit a hand.

### Proposed fix

In the fold path, after step 6 sets the next `activePlayerIndex`, call `checkBettingComplete(tx, currentHand.id, freshPlayers)`. If it returns true, do exactly what the check/call/raise/all-in success path does: advance to next street (deal flop/turn/river community cards) OR run showdown if we just finished the river.

Concretely: refactor so the fold path's "happy continue" branch falls through to the same post-action betting-completion logic the other actions use. That logic already handles the deal-next-street and run-showdown cases.

Add a vitest case for the exact Hand 9 flop scenario (3 players post-flop: A checks, B checks, C raises, A folds → assert street advances to turn, no phantom actor expected).

### Risk

`processAction` is the heart of the engine and we've had subtle regressions touching it before. Two things give me confidence:

1. The fix is **additive** — call `checkBettingComplete` in a path where we currently DON'T. Won't change behaviour when the existing path is correct (which is most of the time).
2. The 140/138 vitest suite already covers the major action flows. The fast-forward-on-fold case is covered. A targeted new test for the lap-bug repro will catch this.

But there are landmines:
- The fold handler has its own "remainingNonAllIn <= 1 → showdown" branch that catches some completion cases. I need to make sure my new `checkBettingComplete` call isn't redundant or contradictory with it.
- After completing a street via the fold, we need to set `currentBet = 0` and advance `stage` and `activePlayerIndex` to the correct first-to-act for the new street. The other actions' success path does this; I need to share that logic, not duplicate it.

**Gerald — please tell me:**
- Is there a clean way to refactor the fold path to share the post-completion logic with the other actions, rather than copy-paste it?
- Anything about side pots / all-in interaction with the fold-completion case I should be paranoid about?
- The "remainingNonAllIn <= 1 → showdown" fold branch already runs the showdown when all-but-one are all-in. After my fix, could there be a case where `checkBettingComplete` returns true and my code tries to run showdown when the existing branch already ran it? (I think no, because the existing branch returns early, but worth checking.)

---

## Issue B — Pocket 9s "auto-played through": **NOT A BUG, BAD UX**

### Evidence

Hand 3 of CeceShaunV3. From the HandEvent `showdown_evaluated` payload (full audit trail preserved):

- Shaun's hole cards: **9♠ 9♦** ✅
- Board (after fast-forward): 3♠ 8♦ 4♣ 7♦ 9♥
- Shaun won with three-of-a-kind 9s
- 5 side pots, total $19.60

What actually happened preflop:
1. Shaun raises to $2.20. Multiple callers.
2. bot_e06 (short stack) goes all-in for $1.80 (less than the call amount — short all-in)
3. Shaun re-raises to $4.40
4. bot_4cf goes all-in for $3.60
5. After bot_4cf's all-in, only ONE non-all-in active player remains (Shaun)

`processAction` correctly detects this and fast-forwards through flop/turn/river community cards, then runs showdown. Engine is right. The `street_advanced` HandEvent has `foldFastForward: true` (slight misnomer — it's an all-in fast-forward, not fold).

### Why Shaun perceives it as a bug

The UX is: "raise, raise, raise → showdown modal with the full board already filled in". From the player's POV the hand just *ends* with no visible flop/turn/river reveals. Feels like a teleport.

### Proposed UX fix

Two options Shaun suggested. I'll do option 2 (he prefers it).

**Option 2 — animated all-in fast-forward (Shaun's suggestion):**
- When `processAction` returns with `allInFastForward: true` (or equivalent flag), don't immediately show the showdown modal.
- Frontend orchestrates:
  1. Flip all all-in players' hole cards face-up (enlarge them).
  2. Animate each remaining street card flipping onto the board, **1 second delay between each card**.
  3. If we fast-forwarded from preflop: 3-card flop → 1s → turn → 1s → river → 1s → showdown modal.
  4. If from flop: turn → 1s → river → 1s → showdown.
  5. From turn: river → 1s → showdown.
- Need a new server flag in the showdown payload telling frontend "this was a fast-forward from stage X" so frontend knows how many cards to animate.

### Risk

Frontend-orchestrated reveals risk desync if the showdown payload arrives faster than the animation finishes. The fix is to BLOCK the showdown modal mount until the animation completes, but allow the underlying state push (pot awarded, balances updated) to land in the background. Same pattern as the existing deal-animation `onComplete` callback.

**Gerald — please tell me:**
- Should the "fast-forwarded from stage X" be a backend-side flag (added to showdown payload) or should the frontend infer it from `board.length` vs `stage` history? Backend feels cleaner; less likely to drift.
- Any concern about the in-flight balance update arriving BEFORE the animation completes? Players might see their balance change before they see the river card flip. Acceptable?

---

## Issue F — Blind escalation: **CONFIRMED, REMOVE ENTIRELY**

### Evidence

From CeceShaunV3 blind actions over the 24 hands:

```
Hands 1-10:  SB=$0.10  BB=$0.20  (Shaun's starting blinds)
Hands 11-20: SB=$0.20  BB=$0.40  (doubled at hand 11)
Hands 21-24: SB=$0.50  BB=$1.00  (jumped 2.5x at hand 21)
```

Source: `packages/backend/src/services/blindSchedule.ts`. `HANDS_PER_LEVEL = 10`. 8-level default schedule.

Called from `checkGameContinuation` (in `pokerActions.ts`) which runs after every hand completes. It bumps `Game.blindLevel` and `Game.handsAtLevel` and writes new blind values for the next hand.

### Shaun's decision

**Kill it entirely.** Blinds stay at whatever was set at game-create time for the entire match. No tournament mode for now.

### Proposed fix

Simplest: early-return `null` in `checkBlindIncrease`:

```ts
export function checkBlindIncrease(
  currentLevel: number,
  handsAtLevel: number
): { newLevel: number; blinds: BlindLevel } | null {
  return null; // Blind escalation disabled (Shaun 2026-05-14)
  // Original logic preserved below for future tournament mode.
  // if (handsAtLevel >= HANDS_PER_LEVEL) { ... }
}
```

Keeps the call site untouched so we don't need to audit every consumer. Future re-enable is a one-line revert.

### Risk

Minimal. The function only returns "new level" or "null". Returning null means callers skip the blind bump and `handsAtLevel++` continues counting (harmless — never reaches the threshold check). All existing tests that don't specifically test escalation will pass unchanged.

If any vitest case specifically tests blind escalation, it'll fail and tell me explicitly. I'll fix or skip those tests as part of the commit.

**Gerald — please tell me:**
- Any reason to prefer killing it at the call site instead of inside `checkBlindIncrease`? Either works; I lean toward inside-the-function so callers don't need to know.
- Should I leave the `handsAtLevel`/`blindLevel` columns in the schema even though they're now unused? My instinct is yes — schema migrations are expensive and we'll want this back when we add tournament mode.

---

## Issue A — Check/Fold button covers hero hole cards: **SCREENSHOT-CONFIRMED**

### What's wrong

I shipped the pre-action button at `top: 100%, left: 50%` of the felt container with `transform: translate(-50%, 4px)`. The hero seat uses 'bottom' horizontal layoutMode (avatar+plate stacked on the left, hole cards extend horizontally to the RIGHT, hanging just below felt's bottom edge). So my anchor lands exactly where the cards visually are.

Shaun's screenshot 1 confirms the button is rendered directly over his K♦ K♦.

### Proposed fix

Render the pre-action button **INSIDE the hero seat's render block** (the same per-seat JSX that places avatar+plate+holecards). Position it BELOW the hole cards row in the seat's local flex flow.

This way the button always sits directly below the cards no matter what viewport/layout-mode applies, because it's part of the same DOM group.

### Risk

Mobile layout (`PokerTableMobile`) already does this correctly (button rendered inline after the hero seat row). Just need to mirror that approach in `PokerTable.tsx`'s per-seat render for the hero case.

Edge cases:
- Hero might also be on a 'side' or 'top' layoutMode in some seat configurations (e.g. 2-player game where hero seat ends up at left or right). Need to ensure the button still sits sensibly. I'll render it after the cards in the local flex flow which adapts to layoutMode automatically.

---

## Issues D + E — Double deal / cards visible before deal animation: **NEEDS LIVE REPRO**

### Symptoms

Shaun reports: between hands or before deal animation fires, "my cards aren't there, but all bots cards are showing". Also: deal animation feels like it plays twice (cards visible → animation flies in → cards "land").

### What SHOULD happen (from code review)

1. Hand ends → `setBetweenHands(true)` fires from `game:showdown` or `game:fold-win` handler in GameRoom.
2. PokerTable renders cards as `betweenHands ? null : <normal-card-render>`. With `betweenHands=true`, BOTH hero face-up AND opponent face-down cards are null.
3. Server timing: t=0 hand ends → t=10s emit `game:next-hand-chime` → t=12s emit `game:new-hand` + broadcast new state.
4. Frontend on `game:new-hand`: `setDealTrigger(t+1)` fires deal animation. `betweenHands` STAYS true (only cleared via animation `onComplete`).
5. Deal animation runs 1.5-2.6s, `onComplete` → `setBetweenHands(false)` → cards reveal.

This should produce a CLEAN sequence with no cards visible during the wait or during the animation.

### Suspected actual bug

If Shaun sees opponent CardBacks BUT no hero hole cards, that combination means:
- `betweenHands` is FALSE (otherwise both would be null)
- Hero's `holeCards` array is EMPTY (otherwise hero would show face-up cards)
- Opponents are `active` (not folded/eliminated) so the existing render branch shows 2 CardBacks each

The only way `holeCards` is empty for hero is between hands (server's `checkGameContinuation` resets `holeCards: '[]'` for the next hand). And the only way `betweenHands` is false in that window is if it got flipped early.

**I cannot reproduce this from code review alone.** Need to capture the live render at the exact moment via playwright.

### Proposed fix

Belt-and-braces — two independent gates instead of one:

1. **Gate card render on EITHER `betweenHands` OR `stage in ('waiting','completed','showdown')`.** Multiple independent signals prevent stale-flag bugs from leaking cards. If either says "no hand in progress", no cards visible.

2. **Add a 4s fallback timeout** to flip `betweenHands` false after `game:new-hand`. If animation `onComplete` doesn't fire for any reason (race, mount/unmount cycle, ref stale), the cards STILL reveal after 4s.

3. **Live playwright repro** before claiming the fix works. Headless test that creates a game, plays a hand, captures screenshots every 200ms during the hand-end → next-hand-deal window. Confirms the new gates correctly hide ALL cards through the entire 8s gap (after Issue G reduces 10s→8s).

### Risk

The belt-and-braces gate is purely additive — `betweenHands && stage-not-in-progress` is a strictly stricter condition than `betweenHands` alone, so we never SHOW cards we didn't show before. We only HIDE more aggressively.

Worst case: the 4s timeout fires before animation finishes and reveals cards mid-flight. But the timeout starts on `game:new-hand` and animation runs 1.5-2.6s, so 4s leaves 1.4-2.5s of margin. Safe.

**Gerald — please tell me:**
- Is "two independent gates" the right pattern here, or am I overthinking it? Single state flag SHOULD be enough if I can find why it's wrong.
- Any pattern you've seen for "this animation MUST complete before I flip state" that's more robust than the current `onComplete` callback?

---

## Issue G — 10s→8s, chime + deal animation simultaneously

### Current

Backend timing in `pokerActions.ts` after hand completes:
```
t=0:    emit game:next-hand-countdown(10)
t=10s:  emit game:next-hand-chime
t=12s:  initializeHand + emit game:new-hand + broadcast state
```

Frontend on `game:next-hand-chime`: plays chime. On `game:new-hand`: triggers deal animation.

### Proposed (per Shaun)

```
t=0:    emit game:next-hand-countdown(8)
t=8s:   emit game:next-hand-chime + initializeHand + emit game:new-hand + broadcast state (all in one block)
```

Chime fires AT THE SAME INSTANT as the deal animation starts. Chime is ~1.4s sound, animation is ~1.5-2.5s — they overlap.

### Risk

Minimal. Just timing. Test in headless playwright with audio enabled to confirm chime + animation feel coherent rather than chaotic.

---

## Issue H — Table size +/- buttons

### Spec (per Shaun)

- Two buttons next to the audio toggle in the GameRoom header
- Zoom levels: 80% / 90% / **100% (default)** / 110% / 120%
- Hover tooltip: "Increase/decrease table size to suit your screen"
- localStorage-persisted

### Proposed

CSS `transform: scale(N)` on the table container with `transform-origin: top center`. localStorage key like `t3-table-zoom` = `'80' | '90' | '100' | '110' | '120'`.

### Risk

`transform: scale` doesn't affect layout dimensions, so a scaled-up table will visually overflow its container. Need `width: calc(100% / scale)` adjustment or a wrapping container with `overflow: visible`. I'll test this and adjust before shipping.

---

## Plan — 3 commits, in this order

### Commit 1 — Lap bug fix (Issue C)
- Backend only: refactor fold path in `processAction` to call `checkBettingComplete` and share the post-completion logic with the other actions.
- New vitest case for the Hand 9 flop reproducer.
- All existing tests must pass: 140/140.

### Commit 2 — Disable blind escalation (Issue F)
- One-line change in `blindSchedule.ts`. Early-return null in `checkBlindIncrease`.
- Update any escalation-specific vitest cases.

### Commit 3 — Frontend cluster (Issues A, B, D, E, G, H)
- Issue A: pre-action button inside hero seat block.
- Issue B: server adds `fastForwardFromStage` to showdown payload; frontend animates remaining streets with 1s delays + enlarged all-in player cards.
- Issues D+E: belt-and-braces card gate (`betweenHands` OR `stage-not-in-progress`); 4s fallback timeout. Playwright repro to validate.
- Issue G: 10s→8s, chime+animation simultaneous.
- Issue H: table zoom controls.

---

## What I want from you, Gerald

In order of importance:

1. **Issue C (lap bug)** — review my proposed fix shape. Is calling `checkBettingComplete` in the fold path the right approach, or am I missing a cleaner refactor? Any subtle interaction with side pots / fold-win / all-in fast-forward I should be paranoid about?

2. **Issues D + E (cards before deal animation)** — am I overthinking with the two-gate approach, or is single-gate truly enough if I can find why `betweenHands` is wrong? Any pattern you've seen for animation-completion gating that's more robust than `onComplete`?

3. **Issue B (all-in fast-forward UX)** — should "this was a fast-forward from stage X" be a backend flag or frontend inference? Concern about pot/balance updates arriving before animation completes?

4. **Anything else you see** — any of these proposed fixes look like they'd break something I haven't considered?

I'll wait for your reply before shipping commit 1. Commit 2 and 3 I can probably do without your sign-off since they're lower-risk, but I'll wait for you anyway in case you spot something.

Thanks Gerald.

— Dave
