# 20 — Gerald brief: bulletproofing the legitimate gameplay path

**For:** Gerald
**From:** Dave
**Date:** 2026-05-09
**Branch:** `main` @ `c1e0f04` (post-Railway-smoke audit; nothing implemented for this brief yet)

---

## What we're doing and why

Shaun's directive: before any further anti-cheat work, **prove the legitimate
poker gameplay path is bulletproof**. The reasoning is sound — a cheat-resistant
game that doesn't deal hands correctly is worthless. Real-money users will hit
gameplay bugs through normal play long before any adversary attempts to exploit
the system.

Goal in his words: *"I want very high confidence that this game works exactly
as it should with a poker can [sic — pokering], that nothing breaks, and that
no player can cheat or alter the outcome or chips distribution."*

For this round, **scope = legitimate play only**. Anti-cheat / adversarial
testing is the next phase.

End-state we're trying to reach: a fast, deterministic, in-process regression
suite that exhaustively covers every legal action sequence at every player
count from 2–8, at every betting stage, with strict per-step invariants. If
any test ever flakes, that's a real bug — not test noise.

---

## Where we are now

- 11 vitest test files / 68 unit + sim tests pass on `main` (`tests/sim/`,
  `tests/unit/`).
- Bot harness over real HTTP+sockets exists, 19 scenarios, parallel-safe (per
  audits 16–18). Last full parallel run: 19/19 PASS.
- Railway smoke (audit 19): 16/16 PASS on the deployed `a4e2111`.

What we have is **good** as integration / smoke / API coverage. What we
**don't** have: a systematic, scripted, deterministic gameplay suite that
covers every player-count × stage × action combination. The existing
`tests/sim/` files are hand-written one-offs; they're not a generator and
they don't enumerate combinations.

---

## Proposed build (3 layers)

### Layer A — Scripted scenario DSL

A tiny test DSL that lets us write a hand as a readable script, with a
forced deck and per-step invariants between every action.

```ts
runScripted({
  players: 4,
  stacks: [200, 200, 200, 200],
  blinds: { sb: 1, bb: 2 },
  deck: [/* forced deck for determinism */],
  script: [
    { actor: 'BTN',  action: 'raise', amount: 6 },
    { actor: 'SB',   action: 'fold' },
    { actor: 'BB',   action: 'call' },
    { actor: 'UTG',  action: 'call' },
    { stage: 'flop', expectBoard: ['Ks', '7h', '2c'] },
    { actor: 'BB',   action: 'check' },
    // ...
  ],
  expect: {
    finalStacks: [206, 199, 198, 197],
    handsCompleted: 1,
    chipsConserved: true,
  },
});
```

Invariants run BETWEEN every action:
- chip conservation (Σstacks + Σpots = initial)
- no negative stacks
- exactly one active actor (or 0 between stages)
- hand-stage monotonic (preflop → flop → turn → river → showdown → completed)
- pot = sum of recorded contributions
- folded/all-in players cannot be the active actor
- only legal actions accepted from each actor's state

On failure: deterministic step number, full state diff, deck used,
seat positions. Reproducible from a single line.

### Layer B — Hand-crafted scenario library (~60 scripts)

Targeted, named scenarios across every player count:

- **Heads-up (~12)**: SB walk, BB option, limp-raise, 3-bet, 4-bet all-in,
  river check-raise, min-raise river, short vs deep, split pot, both
  all-in different stacks, trips on board kicker, quads chop.
- **3-handed (~10)**: BTN/SB/BB rotation, reopening-action edge cases,
  side pot with one short stack, walks at multiple seats.
- **4-handed (~10)**.
- **5–8-handed (~6 each)**: deep-stack multi-way, multi-way all-ins with
  multiple side pots, position rotation across 30 hands.

Each runs in single-digit milliseconds via the in-process sim. Whole library
runs in 1–2 seconds.

### Layer C — Combinatorial generator

Enumerates legal action templates over:
- Player counts {2, 3, 4, 5, 6, 7, 8}
- Stack profiles {equal-deep, equal-short, one-short, one-deep, two-shorts,
  asymmetric}
- Action templates {fold-pre-everywhere, all-call-see-river, raise-fold-pre,
  raise-call-see-flop, all-in-confrontation, multi-way-all-in}

Cross product = several hundred generated scenarios. Each picks legal actions
at every decision point. Same invariants apply. CI-friendly; runs in 1–2
minutes.

### After all 3 layers pass

Layer A/B/C is the **gameplay** floor. Once green, the bot harness becomes
pure integration/stress, and we move on to the anti-cheat suite (Shaun's
phase 2). Not in scope for this brief.

---

## Time estimate

- Layer A (DSL + invariants): ~2 hours
- Layer B (~60 scripted scenarios): ~3 hours
- Layer C (generator): ~2 hours
- Bug-fix iteration: open-ended; budget 2–4 hours. The whole point is
  finding bugs.

Total: roughly one focused day.

Pass criterion (Shaun-confirmed): **100% pass rate, zero flake.** Any
flake = real bug.

Order of operations (Shaun-confirmed): Option B — build Layer A, run a
few scripts, fix bugs as they appear incrementally, then add more.

---

## Three questions where I want your second opinion

These came up scoping the build. Shaun asked specifically that you weigh in
on each. Stated my preferred approach and trade-offs; tell me where I'm
wrong.

### Q1 — Forcing the deck for deterministic tests

The current `holdemGame.ts` shuffles server-side via `crypto.randomInt`. To
make tests deterministic I need a way to inject a known deck. Three options:

**(a) Test-only env hook.** Read `process.env.TEST_DECK` at shuffle time.
**Pros:** zero refactor of any production code path. **Cons:** introduces a
production code path that reads env at runtime, even if it's gated. Smells
bad — exactly the kind of thing an attacker probes for.

**(b) Optional `deck` parameter on `initializeHand` / `shuffleDeck`.**
Default = real RNG. If `deck` is provided, use it. **Pros:** clean
function-signature change. Tests pass `{ deck: [...] }`. Production code
never sets it. **Cons:** if anyone ever wires this through to user input or
admin endpoints, that's a fairness disaster. Has to stay sim-only.

**(c) Seed the crypto RNG deterministically.** Replace `crypto.randomInt`
with a swappable interface (e.g. `Random.next()`); production gets the
crypto-backed implementation, tests get a seeded one. **Pros:** cleanest
architecturally. The deck is still "shuffled" — just from a known seed.
**Cons:** biggest refactor. Touches the shuffle path. Risk of subtle
behavior change.

**My pick:** (b). Sim-only `deck` parameter, callsite in
`initializeHand` reads it if set, otherwise falls back to `crypto.randomInt`.
Lower risk than (c) and avoids env smell of (a).

**Where I'd want your eyes:** (c) is technically cleanest, but the refactor
risk is real. Is there a fourth option I'm missing? Or do you want me to
take (c) anyway and treat it as a small Phase-11 hardening?

### Q2 — Position labels in game state

Tests like `{ actor: 'BTN', action: 'raise' }` need a way to map an
abstract position to a seat. The current `getGameState` response includes
`position: 'active' | 'all_in' | 'folded' | 'eliminated' | 'waiting'` —
that's seat status, not poker position. Poker position (BTN, SB, BB, UTG,
HJ, CO, etc.) has to be derived from seatIndex + dealerIndex.

Two options:

**(a) Add `pokerPosition` to the state shape.** Server computes it once
and emits it. Tests read it directly. UI also benefits (shows "BTN"/"SB"
in client without re-deriving). **Pros:** clean for tests + UI. **Cons:**
adds a field to the broadcasted state shape, more bytes per push.

**(b) Compute it client-side / test-side.** Tests have a helper that
takes the state and resolves `'BTN'` → seat index. Server unchanged.
**Pros:** no production change. **Cons:** every consumer reimplements
the same lookup logic. Tests + UI both need it.

**My pick:** (a) for the long game (UI will want it anyway), but I can
ship (b) for now and revisit (a) later if you'd rather not touch state
shape today.

**Where I'd want your eyes:** is there any reason adding `pokerPosition`
to the state would break existing clients? I haven't audited what the
frontend expects.

### Q3 — Position naming in test scripts

Should scripts use abstract positions (`'BTN'`, `'SB'`, `'BB'`) or seat
indices (`seat: 0`, `seat: 1`)?

- **Abstract reads better** for single-hand tests. "SB raises to 6, BTN
  3-bets" is what a poker player thinks.
- **Seat indices are unambiguous** when the dealer rotates between hands
  — across 30 hands, "BTN" is a different seat each time, but seat 3 is
  always seat 3.

**My pick:** support both. Abstract for the readable single-hand library
in Layer B. Seat indices for any multi-hand or generator-driven script
in Layer C.

**Where I'd want your eyes:** if you've seen this kind of test DSL
before in another project, what convention won? I don't want to invent
something that's been solved.

---

## What I'm asking from you

- **Yes/no/different on each of Q1, Q2, Q3** — your second opinion is
  the gate Shaun wants before I start.
- Anything obviously wrong with the 3-layer plan or scope.
- Anything I should add to the Layer B library that I missed
  (especially edge cases you've seen burn other poker codebases —
  reopening-action rules, dead-button edge cases, accidentally-going-to-
  showdown-with-no-cards, etc.).

If you green-light or modify the plan, Shaun will give the go-ahead and
I'll start Layer A immediately.

---

## Reference

- `audits/t3-poker/16-harness-bulletproofing-pass.md` — original harness brief
- `audits/t3-poker/17-harness-gerald-fixes.md` — your last review fixes
- `audits/t3-poker/18-gerald-harness-fixes-reaudit-brief.md` — re-audit brief you signed off on
- `audits/t3-poker/19-railway-smoke-test.md` — 16/16 Railway smoke pass

Existing test trees:
- `packages/backend/tests/sim/` — current in-process simulator tests
- `packages/backend/tests/unit/` — unit tests
- `packages/backend/tests/harness/` — bot harness over HTTP+sockets

Current backend HEAD: `a4e2111` deployed on Railway, smoke green.
