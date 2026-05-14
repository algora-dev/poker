# Gerald brief — Per-action server latency (~5s)

**Status:** dominant open loop. Shaun reports the game *feels* slow between turns. We've reduced perceived latency a lot (turn timer cuts, bot thinkMs=0, faster next-hand delays, removing client refetches) but the underlying server cost per action is still way too high.

**Ask:** fresh pair of eyes. We've stared at this enough that we may be missing something architectural / Prisma-shaped / index-shaped. Tell us what we're not seeing.

---

## The headline number

From production `TIMING:` log lines emitted at the end of `processAction`:

```
query=1217ms  action=2400ms  betting=1217ms  turn=617ms  TOTAL≈5200ms
wait=<tx queue time before t0>
```

Per single player action (fold / check / call / raise / all-in). Multiplied across 8 seats × multiple streets, this is the single biggest UX problem we have. Bots feel slow even at `thinkMs=0` because the server is the bottleneck.

**Stack:** Node + Prisma + PostgreSQL (Supabase) over the wire from Railway. Single region; we believe latency is dominated by sequential round trips inside one `prisma.$transaction` block, not by CPU.

---

## File of interest

`packages/backend/src/services/pokerActions.ts` — function `processAction` (around line 12 onwards). Every player action goes through this. The whole thing is one big `prisma.$transaction(async (tx) => { ... })`.

The four phases we measure:

1. **query (t0→t1, ~1.2s):** initial `tx.game.findUnique` with nested `players` (with user select) and current open `hand`, then `tx.gamePlayer.findFirst` for the actor, then the optimistic-concurrency `tx.hand.updateMany` guard.
2. **action (t1→t2, ~2.4s):** the action switch (fold/check/call/raise/all-in). Each branch does its own `tx.handAction.aggregate({ _sum })` over current-stage contributions, then `tx.gamePlayer.update`, then `tx.handAction.create`, plus a `recordHandEvent` (writes a HandEvent row to the ledger).
3. **betting (t2→t3, ~1.2s):** `checkBettingComplete(tx, handId, players)` which does `tx.hand.findUnique` + `tx.handAction.findMany` (current stage) + `tx.game.findUnique` (for bigBlind) and then a pure-JS walk.
4. **turn (t3→tEnd, ~0.6s):** if betting not complete: `tx.gamePlayer.findMany` (fresh positions) + `tx.hand.update` to set next active player. If complete: street advance OR showdown (much heavier).

So per non-terminal action we're doing roughly **8–12 sequential `tx.*` calls** before we even consider street/showdown logic. Showdown paths add many more (handleShowdown, side-pot calc, multiple gamePlayer updates, hand update, multiple recordHandEvent calls, chip audits, money events).

---

## Things we've already tried / verified

- **N+1 fix on the read side** (Round 1) — the broadcastGameState read path used to do per-player queries; that's gone. The remaining ~5.2s is the **write-side** transaction. ✅ done
- **Indexes** — we *think* the main hot queries are covered (HandAction by `handId + stage`, GamePlayer by `gameId`, Hand by `gameId` ordered). We have not done a `pg_stat_statements` pass with the actual workload. ❌ not verified end-to-end
- **Connection / region** — Railway (backend) ↔ Supabase (DB) are both in the same Vercel/Railway US region; we have not pinned this with `pg_stat_activity` round-trip timings.
- **BigInt aggregates** — Prisma's `_sum` over `BigInt amount` columns is used several times per action. We've not profiled whether this is unusually slow vs. raw `SELECT SUM(amount)`.
- **Optimistic concurrency guard** (`tx.hand.updateMany` on `{id, activePlayerIndex, stage, version}`) is necessary and we don't want to remove it.

---

## Where we suspect the cost is hiding

These are *suspicions*, not conclusions. Tell us which are red herrings.

1. **Per-action `handAction.aggregate` ×2** — call / raise / all-in branches each run a `_sum` aggregate over `HandAction` for `{handId, userId, stage}` to compute "already contributed this street". Then `checkBettingComplete` re-reads the SAME `HandAction` rows by `{handId, stage}` again. We're scanning the same hot rowset multiple times per action.

   Could we read all stage actions once at the top of `processAction` and pass them down, eliminating ≥3 round trips per action? Is there a reason we can't?

2. **`recordHandEvent` inside the hot transaction** — ledger writes (HandEvent rows) happen for `action_applied`, `street_advanced`, `pot_awarded`, `hand_completed`, etc. They're not on the critical path for correctness of *this* action; they're an audit trail. Should they be deferred (outbox pattern: write to a queue table inside the tx, drain async) so the player-visible latency drops?

   Concern: the audit invariants in our harness/gameplay tests assert on the ledger being consistent with chip state. Any move off the tx must preserve that.

3. **`game.findUnique` with nested `players → user`** at the start — we re-query nearly the same data after fold (`tx.gamePlayer.findMany` again), and again in `checkBettingComplete` (re-read hand), and again at the turn-switch (`tx.gamePlayer.findMany`). Are we paying for 3–4 reads of essentially the same dataset per action?

4. **Transaction round-trip count, not DB CPU** — Supabase is over the wire; each `await tx.x` is a network round trip from Railway → Supabase pooler → Postgres. If we have 10 sequential round trips at ~120ms each, that's exactly the ~1.2s we see in each phase. The "fix" might be batching / `$queryRawUnsafe` for the read-then-update pattern, OR moving the whole action into a single Postgres function / `WITH RECURSIVE` style block. Smell-check please.

5. **Prisma transaction default timeout / isolation** — we use the default. Are we accidentally on a higher isolation level that's making this worse under contention? We've not configured `isolationLevel`.

6. **`turnStartedAt: new Date()` on hand update** — minor, but two separate `tx.hand.update` calls in the non-complete path (one for activePlayerIndex, sometimes one for stage too). Could be merged.

---

## What we want from you

We do NOT want a rewrite of the engine. We want you to:

1. **Read `packages/backend/src/services/pokerActions.ts` end-to-end** (it's ~1400 lines, sorry).
2. **Tell us the 3 biggest latency reductions** you'd make to `processAction` without changing game semantics, ranked by expected win.
3. **Tell us anything we have wrong** in the suspicions above. Especially: is the ledger-in-tx really safe to defer? Is batching `tx.handAction` reads at the top safe given the optimistic-concurrency guard?
4. **Sanity-check** that we haven't missed an obvious indexing gap. Schema is Prisma-managed; you can read `packages/backend/prisma/schema.prisma`.
5. **Flag any correctness risks** in our current path that we'd be tempted to ignore while optimising. Money is on the line; we don't trade fairness for speed.

---

## Context pointers

- `packages/backend/src/services/pokerActions.ts` — the hot function.
- `packages/backend/prisma/schema.prisma` — schema + current indexes.
- `packages/backend/src/services/handLedger.ts` — `recordHandEvent` (called inside the tx).
- `packages/backend/src/services/sidePots.ts` — showdown-time pot calc (separate latency story; not the primary target here but interesting if showdown timing is hit).
- `MEMORY.md` (workspace root) → "Current Open Loops" → DOMINANT entry has the latest TIMING breakdown.

---

## Constraints

- Server-authoritative. Never trust the client. Never move legality checks (min-raise, current-bet, stack caps, isYourTurn) out of the tx.
- Money safety wins over speed. ChipAudit + MoneyEvent + the H-04 active-game money lock must keep working.
- Don't break the optimistic concurrency guard. Concurrent action races at one seat must continue to reject cleanly with `Stale action - turn already advanced`.
- Don't break the gameplay test layer (`packages/backend/tests/gameplay/`) or the harness (`packages/backend/tests/harness/`). 68/68 vitest + harness scenarios are the regression bar.

— Dave
