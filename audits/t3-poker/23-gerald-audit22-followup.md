# 23 — Gerald audit-22 follow-up: H-01 fix + M-01 wiring

**For:** Gerald
**From:** Dave
**Date:** 2026-05-09
**Branch:** `main` (about to push, `c70270f` → new HEAD)
**Companion docs:**
- `audits/t3-poker/22-gerald-gameplay-handoff.md` — original handoff
- `workspace-gerald/audits/t3-poker/22-gerald-gameplay-handoff-review.md` — your review

---

## Both findings closed

- **H-01 (High / Likely):** fold leaving zero non-all-in players → showdown fast-forward path now handles `remainingNonAllIn.length <= 1` (was `=== 1`). Plus a safety guard after the next-player skip loop that fast-forwards to showdown rather than assigning `activePlayerIndex` to a folded/all-in seat.
- **M-01 (Medium / Confirmed):** legality oracle wired into `runScripted()`. New `legalityFailures` field on `ScriptedResult`. New `allowIllegalActions: true` opt-in for negative tests that want the engine to see and reject the bad input. 4 oracle unit tests + 2 DSL integration tests.

Full vitest: **19 files, 112/112 PASS in 2.28s.**

---

## H-01 fix detail

### Before

In `processAction`'s fold case:

```ts
const remainingNonAllIn = remainingActive.filter(p => p.position !== 'all_in');

if (remainingActive.length === 1) { handleFoldWin(...) }
if (remainingNonAllIn.length === 1) { fast-forward to showdown }
// otherwise: find next active player...
```

When a fold left **two or more all-in players and zero non-all-in players** (your TH-07 case), neither branch fired. Code fell through to the next-player loop, which skipped folded/eliminated/all_in seats — including the just-folded player — and could exhaust without finding any actor, then silently wrote `activePlayerIndex = nextIdx` (a bogus value).

### After

`pokerActions.ts` fold case:

```ts
// If 0 OR 1 non-all-in players remain (with at least one all-in
// player still live), there are no more decision points. We must
// fast-forward through remaining streets and run a showdown so
// all-in players' main-pot equity is contested.
if (remainingNonAllIn.length <= 1) {
  // existing fast-forward + handleShowdown path
}
```

Plus a safety guard inside the multi-player-still-active branch:

```ts
if (safety >= numPlayers) {
  logger.warn('No next actor after fold; falling through to showdown', {...});
  // run the same showdown fast-forward as above
}
```

The safety guard exists so that any future bug that lets us reach the
loop with no valid actor surfaces as a logged warning + showdown rather
than a bogus `activePlayerIndex`.

### Regression test

`tests/gameplay/three-handed.test.ts` → `TH-07: fold leaves zero non-all-in players — hand fast-forwards to showdown (Gerald audit-22 H-01)`.

Setup: 3 players (30/30/200). BTN shoves 30, SB shoves 30 (call all-in),
BB folds. After the fold:
- `remainingActive = [BTN, SB]` (both `all_in`).
- `remainingNonAllIn = []`.

Expected behaviour: engine fast-forwards to showdown immediately. Both
all-in players' equity in the contested pot resolves via `handleShowdown`.
With BTN holding KK and SB holding 23o, BTN wins the main pot.

Forced final stacks: `[61, 0, 199]`.
- BTN: 0 stack mid-hand, wins 3 + 58 = 61.
- SB: 0 (busted but game continues since 2 non-eliminated players remain).
- BB: 200 - 1 (folded BB stays in pot) = 199.

The test PASSES, confirming the fix.

### Confirmation no production hooks introduced

The fast-forward block iterates remaining stages by reading the deck
already committed at hand-init (`currentHand.deck`). No new RNG path,
no test-only flags, no env reads. Same code shape as the existing
all-in-mid-hand fast-forward, which is the precedent you flagged.

---

## M-01 fix detail

### Wiring

`tests/gameplay/dsl.ts` imports `validateScriptedAction` from `legality.ts`. Inside the per-seat strategy, before returning the scripted action, the DSL calls:

```ts
const v = validateScriptedAction(view, lastRaiseIncrement, oracleAction);
if (!v.ok) {
  legalityFailures.push({ handNumber, stage, seat, userId, intended, reason, legalKinds });
}
```

The strategy still returns the scripted action (the engine sees it). The pre-validation result is captured into a `legalityFailures` array on `ScriptedResult`. `r.ok` is now `false` if any legality failure occurred. Failure messages include actor seat, userId, intended action, oracle reason, and the set of legal action kinds at that decision point.

### Opt-in negative-test mode

A new `allowIllegalActions: true` flag on `ScriptedConfig` bypasses the
oracle so the engine sees the malformed action directly. Used by negative
tests that want to verify defence-in-depth: that the production engine
rejects illegal inputs even if a buggy client gets past the oracle.

### `lastRaiseIncrement` source

The strategy is synchronous within `match.ts`'s action loop, so it can't
do an async DB lookup. For the current wiring I use the BB as a safe
floor for `lastRaiseIncrement`. This is the most permissive correct
floor: it lets a "min raise = currentBet + BB" check fire correctly for
the **opening** raise on a street, but doesn't tighten when a prior raise
on the same street exceeded BB. In practice that means the oracle catches
"obvious" illegal raises (below BB increment) but not "tight" ones
(below the actual last increment when there's been a re-raise).

For tighter validation we'd need to either:
- pre-walk the script to compute `lastRaiseIncrement` per step before dispatch, or
- expose the engine's running `lastRaiseIncrement` via a hook.

Both are easy follow-ups. The current setup catches the common script
errors (check-while-owing, raise-below-BB-increment, raise-above-stack)
and is a meaningful improvement over no oracle at all. I documented this
as a known limitation in the wiring comment.

### Negative tests added

`tests/gameplay/negative.test.ts` (6 tests, all PASS):

| # | Test | What it proves |
|---|---|---|
| NEG-01 | oracle: check while owing chips | rejects with reason and surfaces legal alternatives |
| NEG-02 | oracle: raise below min increment | rejects with `raise total X < min Y` |
| NEG-03 | oracle: raise above stack | rejects with `would exceed stack` |
| NEG-04 | oracle: call when owed=0 | rejects with `'call' not legal` (use check) |
| NEG-05 | DSL: scripted illegal check surfaces `legalityFailures` | proves DSL wiring catches the script bug |
| NEG-06 | DSL: `allowIllegalActions: true` bypasses oracle, engine rejects | proves defence-in-depth at the engine layer |

The NEG-06 result includes confirmation that `report.failure.reason === 'illegal_action'` and `report.endedReason === 'error'` when the engine sees the bad input.

---

## Side-effect during oracle wiring

Wiring the oracle revealed that the original oracle was too strict on
`call` when stack < owed: it allowed only `all-in` in that case. The
engine accepts `call` here and normalizes it to all-in internally.
HU-04 and HU-05 (existing scenarios) used `call` for an effective
all-in and started failing the oracle pre-validation.

Fix: oracle now accepts `call` whenever `owed > 0`, with the comment that
the engine normalizes the call to all-in when stack < owed. This matches
production engine behaviour. No test had to change.

---

## Required runs (results)

```
$ npx tsc --noEmit
exit=0

$ npx vitest run
 Test Files: 19 passed (19)
 Tests:      112 passed (112)
 Duration:   2.28s

$ npx vitest run tests/gameplay
 Test Files: 8 passed (8)
 Tests:      44 passed (44)   # 38 prior + 1 new TH-07 + 6 negative
```

Tests broken out:
- `tests/gameplay/dsl.test.ts` — 1 (Layer A smoke)
- `tests/gameplay/heads-up.test.ts` — 6
- `tests/gameplay/three-handed.test.ts` — **7** (was 6, +TH-07 for H-01)
- `tests/gameplay/four-handed.test.ts` — 6
- `tests/gameplay/multi-way.test.ts` — 6
- `tests/gameplay/hand-eval.test.ts` — 10
- `tests/gameplay/generator.test.ts` — 2 (drives 162 generated scenarios)
- `tests/gameplay/negative.test.ts` — **6** (new, M-01)

**Total deterministic gameplay paths verified: 268** (was 267, +TH-07).
**Plus 6 negative-legality assertions.**

---

## Confirmation

Per your follow-up checklist:

- ✅ Changed files
  - `packages/backend/src/services/pokerActions.ts` (H-01 fix + safety guard)
  - `packages/backend/tests/gameplay/dsl.ts` (legality oracle wiring + `allowIllegalActions` + `legalityFailures` field)
  - `packages/backend/tests/gameplay/legality.ts` (allow `call` when owed > 0 — matches engine normalization)
  - `packages/backend/tests/gameplay/three-handed.test.ts` (TH-07 regression test)
  - `packages/backend/tests/gameplay/heads-up.test.ts` (assertion helper now prints `legalityFailures`)
  - `packages/backend/tests/gameplay/negative.test.ts` (new, 6 tests)
- ✅ Exact commands/results: `tsc` exit 0, gameplay 44/44, full vitest 112/112.
- ✅ New regression test names: `TH-07`, `NEG-01` through `NEG-06`.
- ✅ No production deck/test hooks introduced. The legality oracle lives
   entirely in `tests/gameplay/`. The H-01 fix uses the engine's existing
   showdown fast-forward pattern with no new RNG/test paths.

---

## Outstanding items I want to flag

1. The opening question from audit 22 about a focused `tests/sim/`-level
   regression test for the original B1 fold-win bug is still open. I
   added a DSL-level test (TH-05) but a sim-level direct `processAction`
   test would be a tighter regression guard. I'll add it next round
   unless you want it now.
2. Differential hand-evaluator cross-check (`pokersolver` or similar) is
   queued for the pre-public-prod phase, not done yet.
3. Anti-cheat phase 2 still pending; awaits your scope confirmation.

If these are blockers for "monitored testnet" sign-off, tell me; otherwise
I'd treat them as the agenda for the next phase.

Branch: `main` (will push after this commit).
