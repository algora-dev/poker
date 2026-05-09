# T3 Poker — Harness findings (Phase 3 manual gate, automated)

Date: 2026-05-07 | Author: Dave | Branch: `fix/phase1-chip-accounting`
Scope: Bot-driven playtest harness exercising the live HTTP + Socket.io
backend with multiple concurrent simulated clients. This is the automation
of Gerald's Phase 3 ask in `10-re-audit-followup-branch.md`.

Harness lives at `packages/backend/tests/harness/` and is wired up as
`npm run harness` (root) / `npm run --workspace=packages/backend harness`.

## What the harness does

For each scenario, a fixed set of bots:

1. Pre-seeds users in DB (bypass per-IP signup limit, harness-only).
2. Mints JWTs directly with `JWT_SECRET` (bypass login limit).
3. Tops up bot bankrolls via `/api/admin/add-chips`.
4. Creator creates a game; the rest call `/api/games/:id/join`.
5. All sockets `join:game` with JWT.
6. Bots subscribe to `game:state`, `game:action`, `game:updated`,
   `game:new-hand`, `game:showdown` and react via a strategy
   (calling-station, random-reasonable, aggro, nit, always-all-in).
7. Per-tick invariants check chip conservation, no stalls, no excess errors.
8. End-of-session ledger check verifies sum(ChipBalance + table chipStack +
   live pot) is conserved across the run.
9. Hand-event sequence numbers checked monotonic per scope.

## Scenarios

| name                         | bots | purpose                                |
|------------------------------|------|----------------------------------------|
| eight_player_full_session    | 8    | full-table mixed-strategy session      |
| all_in_storm                 | 4    | side-pots + all-in showdowns           |
| disconnect_reconnect         | 4    | mid-game socket drop + recovery        |
| action_timeout               | 3    | silent bot triggers 30s auto-fold      |
| cashout_mid_game             | 4    | aggressive busts + game-over           |
| concurrency_blast            | 6    | broadcast + processAction stress       |

## Run summary

Local backend, fresh Postgres, `HARNESS_BYPASS_GLOBAL_RATELIMIT=1`.

| scenario                    | result | hands | duration | notes                                  |
|-----------------------------|--------|-------|----------|----------------------------------------|
| eight_player_full_session   | PASS   |    32 | 24-126s  | full conservation, monotonic events    |
| all_in_storm                | PASS   |     4 | 1.2s     | side-pot + all-in showdown coverage    |
| disconnect_reconnect        | PASS   |    16 | 87s      | 1st pass; SEE H-01 below for 2nd run   |
| action_timeout              | FAIL   |     1 | 244-364s | SEE H-01: chip-leak via cleanup job    |
| cashout_mid_game            | PASS   |    52 | 100s     | eliminations, blind escalation         |
| concurrency_blast           | PASS   |     6 | 2.2s     | high-tempo broadcast OK                |

## Findings

### [HIGH] H-01 — `cleanupFinishedGames` cron credits chips with no audit and no stack-zero

File: `packages/backend/src/jobs/autoStartGames.ts`
Lines: 121-141 (`cleanupFinishedGames`) and 161-178 (`staleWaiting`)

Both blocks do the same thing when forcing a game closed:

```ts
for (const player of game.players) {
  if (player.chipStack > BigInt(0)) {
    const balance = await prisma.chipBalance.findUnique({ where: { userId: player.userId } });
    if (balance) {
      await prisma.chipBalance.update({
        where: { userId: player.userId },
        data: { chips: { increment: player.chipStack } },
      });
    }
  }
}
await prisma.game.update({ where: { id: game.id }, data: { status: 'completed', completedAt: new Date() } });
```

Three problems, in order of severity:

1. **GamePlayer.chipStack is never zeroed.** Chips end up in BOTH the
   off-table `ChipBalance` AND the on-table `GamePlayer.chipStack`.
   Every "stuck game" cleanup effectively duplicates the in-table chips.
2. **No `ChipAudit` row written.** ChipBalance changes silently.
   Violates the append-only ledger principle and means there is no
   audit trail for the chips that appear.
3. **No transaction.** The two writes are independent; a partial failure
   leaves the system in an inconsistent state.

Reproducer (action_timeout scenario):

```
3 bots, each starts with 5,000 chips. All buy in for 200 chips.
- ChipBalance:   3 x 4,800 = 14,400
- table stacks:  3 x 200   =    600
- system total:  3 x 5,000 = 15,000  (correct)

Game stays idle on hand 1 for >120s (silent bot auto-folding cycle).
cleanupFinishedGames fires.

After:
- ChipBalance:   3 x 5,000 = 15,000   (each got 200 back)
- table stacks:  still 200 each = 600   (NEVER zeroed)
- system total:  15,600  (+600 chips out of nowhere)
```

Same pattern observed in `disconnect_reconnect` after the cleanup ran
mid-disconnect (delta +2,186.5 chips).

This explains the chip-leak class of failures the harness reported in
multiple scenarios. It does NOT show up in normal play (hands take <5s
each, never hitting the 120s idle threshold) — only when a game pauses
long enough for the cron to consider it stale.

Suggested fix (sketch, NOT applied — needs Shaun's approval per AGENTS.md
red lines on game economy):

```ts
await prisma.$transaction(async (tx) => {
  for (const player of game.players) {
    if (player.chipStack <= 0n) continue;
    const stackToRefund = player.chipStack;
    const balance = await tx.chipBalance.findUnique({ where: { userId: player.userId } });
    if (!balance) continue;
    const updated = await tx.chipBalance.update({
      where: { userId: player.userId },
      data: { chips: { increment: stackToRefund } },
    });
    await tx.gamePlayer.update({
      where: { id: player.id },
      data: { chipStack: 0n },
    });
    await tx.chipAudit.create({
      data: {
        userId: player.userId,
        operation: 'game_cancel_refund',
        amountDelta: stackToRefund,
        balanceBefore: balance.chips,
        balanceAfter: updated.chips,
        reference: game.id,
        notes: `Stale-game refund: ${game.name}`,
      },
    });
  }
  await tx.game.update({
    where: { id: game.id },
    data: { status: 'completed', completedAt: new Date() },
  });
});
```

### [LOW] H-02 — `Stale action` errors are noisy under broadcast load

The Phase 9 optimistic concurrency check in `processAction` (good, working)
fires frequently when bots react to multiple state pushes for the same
turn. The action path returns 500 with body `Error: Stale action - turn
already advanced`. Functionally harmless: no state mutation.

The harness now treats these as benign and refetches state. Real frontends
likely already do, but worth double-checking `useGameSync` swallows them
without surfacing scary toasts.

### [LOW] H-03 — `game:updated` (auto-fold path) does not push fresh state

`turnTimer.ts` calls `processAction(autoAction)` and emits
`game:updated`, but does NOT call `broadcastGameState`. Clients have to
refetch. This explains some of the stalls the harness saw before adding
auto-fold-aware refetch in the bot.

Easy fix: add `broadcastGameState(gameId, playerUserIds)` after the
auto-action commits, mirroring what `/api/games/:id/action` does.

### [INFO] H-04 — Action endpoint sometimes 500s on bot races

When two bots' state-push handlers fire close together, both may hit
`/api/games/:id/action`. The version guard rejects one with a 500.
A 409/422 with a clear "stale action" code would be friendlier; clients
could distinguish "retryable race" from real server errors.

## What the harness DID validate

- 8-handed games complete normally with mixed strategies under live HTTP+WS.
- Side-pot / all-in showdowns work end-to-end.
- Disconnects + reconnects don't corrupt state.
- Mid-game eliminations + game-over flow correct.
- HandEvent sequence numbers stayed monotonic per scope under concurrency.
- Optimistic concurrency check guards correctly under racing actions.
- Server-issued deposit challenges path was NOT exercised — that's still
  the next manual gate (testnet flow).
- Final session ledger conserves chips when the cleanup-cron bug doesn't
  fire (i.e. all games run to natural completion in <120s idle).

## Recommendation

1. Fix H-01 before merging this branch. It is a real chip-printing bug
   triggerable by anything that pauses a game: a player taking >120s to
   act, a server hiccup mid-hand, a held-up auto-fold.
2. Apply the small H-03 fix while we're in there (it's free).
3. Then proceed to manual testnet deposit flow validation (Gerald's step
   1 in `10-re-audit-followup-branch.md`).

Do not merge this branch to main until H-01 is fixed and the harness
runs all six scenarios green twice in a row.
