# Gerald — Brief: fold-path all-in fast-forward firing prematurely (audit-29)

**Date:** 2026-05-15
**Requester:** Dave
**Status:** Diagnosed from CeceVsShaunV4 playtest hand 5. **This is potentially a chip-accounting bug**, not just UX — need your eyes urgently. I'm holding the fix until you confirm.

## Symptom

Shaun's playtest report: "It seems like the fast forward / animated street reveal is triggering as soon as a player goes all in and a second player matches it, or goes all in too (with a lesser chip amount) and cannot actually contribute any more chips even if this is preflop / early in hand."

His mental model (which I think is correct under WSOP rules): "first it should let any other players after them choose to go all in or match the all in/raise, and if any other players that join that hand have more chips left after calling what they needed to enter the hand then the game should play as it normally does as soon as the flop cards land."

## Evidence — CeceVsShaunV4 hand 5

Game `cmp6wj2im00ehomitph541efo`, hand `cmp6wr6g6017lomitpyooosdg`.

Preflop action order (timestamps abridged):
1. bot5 blind 0.1, bot6 blind 0.2
2. Cece call 0.2
3. **Shaun raise 1.0**
4. bot1 call 1.0
5. bot2 fold
6. **bot3 all-in 0.6** (his whole stack — short all-in, M-01: does not reopen)
7. bot4 call 1.0
8. bot5 fold
9. **bot6 raise 1.8** (BB)
10. Cece call 1.8
11. **Shaun all-in 10.8** (a real reopening raise on top of bot6's 1.8)
12. **bot1 all-in 8.3** (less than 10.8 — short all-in)
13. **bot4 all-in 5.8** (less than 10.8 — short all-in)
14. **bot6 fold**
15. *(Hand ends, fast-forward to showdown)*

After step 14:
- Shaun: all-in
- bot1: all-in
- bot3: all-in
- bot4: all-in
- Cece: **active, has chips, last action was `call 1.8`, has NOT responded to Shaun's all-in re-raise to 10.8. She owes ~9.0 more to call.**
- everyone else folded

`remainingActive = [Shaun, bot1, bot3, bot4, Cece]` (length 5)
`remainingNonAllIn = [Cece]` (length 1)

Engine fold-path at `services/pokerActions.ts` line 167:
```ts
if (remainingNonAllIn.length <= 1) {
  // ... fast-forward through remaining streets ... handleShowdown ...
  return { action: 'fold', gameOver: true, showdownResults: { ... } };
}
```

Triggers. **Cece never gets her decision.** Hand fast-forwards through flop / turn / river / showdown.

## Why I think this is wrong

The `remainingNonAllIn.length <= 1` check is intentional and correct under one assumption: **the betting round on the current street is COMPLETE** when the check fires. The comment block at lines 152-165 even says:

```
If 0 OR 1 non-all-in players remain (with at least one all-in
player still live), there are no more decision points.
```

But this assumption isn't enforced. The check fires the moment a fold reduces `remainingNonAllIn` to ≤1, regardless of whether the **other non-folded players have all matched the current bet or all-in'd.**

In hand 5: bot6's fold left Cece as the sole non-all-in, but **Cece still had unresolved action.** She hadn't matched Shaun's re-raise to 10.8 (she'd only contributed 1.8). She had a real fold-or-shove decision. The engine took it from her.

## My hypothesis — is this a chip-accounting issue?

I'm not sure how `handleShowdown` + `calculateSidePots` handle this state. Two scenarios:

### Scenario X (the safe one)
Side-pot math sees Cece contributed only 1.8 to the pot. She gets her remaining chips refunded as "no eligible equity in any pot above her contribution". She effectively folded silently. **Cosmetic + UX bug, no chip loss.**

### Scenario Y (the dangerous one)
Side-pot math assumes Cece called the max (treats her like she put 10.8 in). Pot is over-credited; her chip stack on the GamePlayer row is decremented by ~9.0 more than she actually agreed to. **Real chip-accounting bug.**

I haven't traced through `calculateSidePots` to know which. Need your eyes on this *first*. This is real-money infrastructure; a chip leak via this path is unacceptable.

## Proposed fix

Add the missing precondition: the `remainingNonAllIn.length <= 1` fast-forward only fires when the **current betting round is genuinely complete**.

Conceptually:
```ts
if (
  remainingNonAllIn.length <= 1 &&
  await bettingRoundComplete(tx, currentHand)
) {
  // fast-forward ...
}
```

If the betting round isn't complete (i.e. there's a non-all-in player who still owes), the fold path falls through to its existing "find next active player" loop and asks Cece to act normally. After her decision (fold/call/all-in), the betting round resolves, and the next street-advance check inside `settlePostAction` correctly determines whether to fast-forward then.

`checkBettingComplete()` already exists (line 539 area) and is called later in the same function. We just need to call it earlier — or refactor so the check happens in one place.

## Questions for you

1. **Which scenario (X or Y) is the side-pot math giving us right now?** I need to know if there's a chip-accounting fire to put out separately. If Y, we need a hotfix to refund affected players first, then the engine fix.
2. **Is `checkBettingComplete()` safe to call from the fold path at line 167?** It currently runs at line 539 after the switch statement. I want to either move it earlier or call it twice (once early in fold path, once at the end). Any reason it isn't already there?
3. **Is there a similar bug in the `case 'all-in'` path?** The all-in case has its own `canStillAct.length <= 1 && allInCount >= 1` check at line 555 — but that one IS gated on `bettingComplete` at line 542. So the all-in path is correct. Only the fold path is wrong. Confirm?
4. **Edge case: blind-walk all-ins.** If preflop, BB blind goes all-in for less than the SB blind, and everyone folds to the SB, what should happen? Need to make sure my fix doesn't break the existing "auto-fold the field, walk the BB" path. (I think the existing `remainingActive.length === 1` fold-win check at line 136 handles this BEFORE the `remainingNonAllIn` check — but please confirm.)
5. **Audit trail check:** can you grep MoneyEvent / ChipAudit rows for hand `cmp6wr6g6017lomitpyooosdg` (CeceVsShaunV4 hand 5) and confirm Cece's chip movements are consistent with what she actually committed (i.e. she put in 1.8 chips total, not 10.8)?

## Out of scope for this brief

- Lobby player-joined stale overwrite (frontend; Phase A)
- Spectator modal text "Watch next hand" (frontend cosmetic; Phase A)
- Pre-action status text shifting layout (CSS; Phase A)
- Orphaned bot-only games not auto-closing (separate bug; Phase A4)

I'm shipping all Phase A items in parallel without waiting on you. Only the engine fix waits.

## Files

- `packages/backend/src/services/pokerActions.ts` line 132-210 (the fold-path `remainingNonAllIn` block)
- `packages/backend/src/services/pokerActions.ts` line 540-595 (the all-in path with `bettingComplete` gate — this is the pattern to copy)
- `packages/backend/src/services/sidePots.ts` (for the chip-accounting Q1)
- `packages/backend/src/services/pokerActions.ts` `checkBettingComplete` (for Q2)

## Ask

Run the side-pot trace for hand `cmp6wr6g6017lomitpyooosdg` to answer Q1. Read lines 132-210 + 540-595 of `pokerActions.ts`. Give me yes/no on Q2-Q4 + the chip-accounting verdict from Q5. I won't ship the engine fix until I have your sign-off.
