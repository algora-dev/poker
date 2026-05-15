# Gerald Second Opinion — Audit 29 Fast-Forward / Unresolved All-In Action
Date: 2026-05-15 | Auditor: Gerald | Scope: Dave brief `29-gerald-fast-forward-brief.md`

## Verdict
Dave is right to stop before shipping: this is a **real backend engine bug**, not just bots acting too fast on the frontend.

Severity: **Critical / Confirmed from code** for game fairness.  
Accounting severity: **High / Likely chip-distribution error, but not an over-debit leak**.

The fold path can fast-forward to showdown while a non-all-in player still has an unresolved decision facing a prior all-in raise. In Dave's hand-5 timeline, Cece should have received a fold/call/all-in decision after bot6 folded. The current code can skip her and run showdown immediately.

Important nuance: I do **not** think this debits Cece for the missing ~9.0 chips. The side-pot code builds pots from actual `HandAction.amount` rows, so it should only include what Cece actually committed. But it may let Cece keep showdown equity with only 1.8 committed when, under real poker rules, she still had to decide whether to fold or put more chips in. That can wrongly redistribute committed chips even without overcharging her.

## Evidence

### Premature fast-forward branch exists
`packages/backend/src/services/pokerActions.ts:148-203`:

```ts
if (remainingNonAllIn.length <= 1) {
  // fast-forward to river + handleShowdown
}
```

This branch runs before the fold path calls `settlePostAction()` / `checkBettingComplete()`. So it assumes "0 or 1 non-all-in players remain" means "no decisions remain". That assumption is false when the last non-all-in player has not responded to a previous all-in raise.

### The all-in path is safer
`pokerActions.ts:539-595` only runs the similar all-in fast-forward inside:

```ts
if (bettingComplete && playerPosition !== 'folded') {
  ...
  if (canStillAct.length <= 1 && allInCount >= 1) {
    // fast-forward
  }
}
```

So the all-in path has the missing precondition. The fold path does not.

### `checkBettingComplete()` would catch the hand-5 state
In the described state:
- Shaun all-in was the last true aggressor/reopening raise.
- Cece is still `active`.
- Cece's cumulative preflop contribution is 1.8, below Shaun's 10.8 high-water bet.
- Cece is not in `actedSinceLastRaise` after Shaun's all-in.

`checkBettingComplete()`'s last-aggressor branch requires every player who can act to have responded since the raise. Cece has not, so it should return `false`.

## Answers to Dave's questions

### Q1. Scenario X or Y?
Neither exactly as Dave framed it.

It is **not Scenario Y** in the narrow sense: I do not see code that would decrement Cece by the missing 9.0 or pretend she contributed 10.8.

Why:
- `calculateSidePots()` sums actual `HandAction.amount` rows for the hand.
- `handleShowdown()` awards side pots from those calculated contribution levels.
- No `MoneyEvent`/`ChipAudit` write happens per hand action; hand wins mutate in-table `GamePlayer.chipStack` only.
- The missing decision path does not create a synthetic call/all-in action for Cece.

But it is also **not safely "Cece silently folded"**. Because Cece remains non-folded/active, `handleShowdown()` includes her in evaluations:

```ts
const players = freshShowdownPlayers.filter(p => p.position !== 'folded' && p.position !== 'eliminated');
```

So she can contest pots up to her actual contribution without making the required decision. That is a real fairness/chip-distribution bug. Existing chips can be awarded to the wrong player even if no extra chips are taken from Cece.

### Q2. Is `checkBettingComplete()` safe to call from the fold path?
Yes, with one caveat: call it **after** the folding player has been marked folded and the fold `HandAction` has been written — which is exactly where Dave's problematic branch currently sits.

Better than duplicating logic inline: remove or gate the early `remainingNonAllIn.length <= 1` block and let the existing `settlePostAction()` call decide whether the round is complete.

Minimal fix shape:

```ts
const bettingComplete = await checkBettingComplete(tx, currentHand.id, game.players);
if (remainingNonAllIn.length <= 1 && bettingComplete) {
  // fast-forward
}
```

Cleaner fix shape:
- Keep `remainingActive.length === 1` fold-win first.
- Then immediately call `settlePostAction()`.
- Only if it returns `null`, find the next active player.
- The "no next actor" safety branch can remain as a final defensive fallback, but should log loudly because it should be unreachable if settlement is correct.

### Q3. Similar bug in `case 'all-in'`?
No, not the same bug. The all-in path is gated by `bettingComplete` before fast-forwarding, so it should wait for outstanding actors.

I would still add a regression covering both paths because the rules are subtle:
- all-in raise → short all-in callers → fold by another player → remaining active player must act;
- all-in raise → every remaining actor has responded → fast-forward is allowed.

### Q4. Blind-walk all-ins edge case
The existing `remainingActive.length === 1` fold-win branch still fires before any all-in fast-forward logic, so normal "everyone else folded and only one player remains" is preserved.

For "one active player + one all-in blind remains", the safe rule is: fast-forward only if the active player has no owed decision under `checkBettingComplete()`.

If the fix makes the active player click check/call in a rare short-blind walk scenario, that is acceptable and much safer than skipping a real decision. If Dave wants pure auto-walk behaviour, add a narrow helper that proves the active player's cumulative contribution is already >= current high-water bet before fast-forwarding.

### Q5. Audit trail / exact hand trace
I attempted a read-only Prisma trace for hand `cmp6wr6g6017lomitpyooosdg` using Dave's backend env, but the configured local DB is not reachable from this session:

```txt
Can't reach database server at localhost:5432
```

I saved the read-only trace helper here in my workspace if Dave/Shaun wants to run it where the DB is reachable:

`C:\Users\Jimmy\.openclaw\workspace-gerald\audits\t3-poker\trace-hand-29.cjs`

Because the DB trace is blocked, I cannot truthfully confirm the live MoneyEvent/ChipAudit rows for that exact hand. Static code review still strongly indicates Cece was not over-debited by 9.0, because side pots use actual action amounts and the hand path does not write off-table ledgers. But I would still have Dave run the trace against the real DB before calling the accounting audit fully closed.

## What aligns with Shaun's frontend observation
Shaun's read is plausible: bots acting quickly makes it visually hard to follow, but this specific issue is not merely animation speed. The backend can genuinely transition from bot6 fold directly to fast-forward/showdown without giving Cece a decision.

In real-money games with humans, this would be more obvious and more damaging: a player would see the board/showdown arrive while they still expected to decide whether to call a shove.

## Required fix before production

### Must-fix engine invariant
Never fast-forward to showdown unless **both** are true:
1. no further betting decisions are possible or owed; and
2. every non-folded/non-eliminated player is either all-in or has matched the current required contribution for the street.

Implementation recommendation:
- Delete/gate the early fold-path `remainingNonAllIn.length <= 1` fast-forward.
- Route fold settlement through `settlePostAction()` / `checkBettingComplete()` first.
- Add a regression test based on Dave's hand-5 timeline.

### Must-have regression assertions
For the hand-5 shape:
- after bot6 folds, hand remains preflop/in progress;
- active player becomes Cece;
- `turnStartedAt` resets for Cece;
- no `street_advanced`, `side_pots_built`, `showdown_evaluated`, or `hand_completed` event is written until Cece acts.

For the resolved shape:
- if Cece folds/calls/all-ins, then and only then settlement can fast-forward/showdown if no further decisions remain.

## Sign-off
Do **not** ship current fold-path behaviour.

I sign off on Dave's proposed direction: add the missing betting-complete precondition. My preferred patch is to remove the special early fast-forward from the fold branch and let `settlePostAction()` be the single settlement gate after a fold, with tests for the exact all-in/re-raise/short-all-in/fold scenario.
