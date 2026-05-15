# Gerald — Brief: missing-cards client desync + eliminated-screen UX (audit-28)

**Date:** 2026-05-15
**Requester:** Dave
**Status:** Diagnosis complete. Quick wins shipping in parallel (mojibake, eliminated-screen → spectator, header padding). I want your eyes on the missing-cards client/server race + the emit-chain order question before I patch.

## Context

Shaun's CeceVsShaunV3 playtest after audit-27 (freeze fix) shipped. Game ran 18 hands cleanly — freeze fix is working. Several smaller bugs surfaced, but two are in the "client/server lifecycle race" family that you've reviewed before (F-03 / audit-27):

### Bug A — Missing cards on one client only

Hand 2. Shaun's screen showed: action bar / pre-action bar visible, turn timer counting, pot rendered, board placeholders rendered, but **no hole cards for himself OR any opponent (no face-down card backs)**. Cece on her client at the same moment saw everything correctly — her own cards, bot card backs, board.

DB state was correct: every player had `holeCards` populated for the hand. So this is purely client-side rendering.

#### Suspected root cause

`packages/frontend/src/components/DealAnimation.tsx` lines 93-104:

```ts
useEffect(() => {
  if (triggerKey == null) return;

  const eligible = playersRef.current.filter(
    p => p.position !== 'folded' && p.position !== 'eliminated'
  );
  if (eligible.length === 0) {
    setFlights(null);
    return;          // ❌ does NOT call onCompleteRef.current()
  }
  ...
});
```

The effect fires when `triggerKey` increments (on `game:new-hand`). The effect reads `playersRef.current` (kept fresh on every render). If `game:new-hand` arrives **before** the `broadcastGameState` that resets positions from 'folded'/'eliminated' back to 'active' for the next hand, `eligible` is empty, the effect early-returns, and **`onComplete()` is never called**.

`onComplete` is what flips `betweenHands` from true → false in `GameRoom.tsx`. So `betweenHands` stays true forever. PokerTable's `hideCards = betweenHands || status !== 'in_progress'` then keeps all cards hidden indefinitely.

Cece's client must have received the broadcastGameState BEFORE the new-hand event (network/socket queuing order), so her DealAnimation effect saw fresh `eligible` players and ran normally.

#### What I want your eyes on

In `packages/backend/src/services/handLifecycle.ts` (the helper you reviewed in audit-27), the schedule-next-hand path emits in this order:

```ts
emitGameEvent(gameId, 'game:next-hand-chime', { gameId });
await initializeHand(gameId);
emitGameEvent(gameId, 'game:new-hand', { gameId });

// THEN broadcastGameState
const gp = await prisma.game.findUnique(...);
await broadcastGameState(gameId, gp?.players.map(p => p.userId) || []);
```

`initializeHand()` is the function that resets player positions, deals hole cards, sets blinds, etc. After it returns, the DB has the fresh hand state. Then `game:new-hand` fires immediately (a tiny payload with no state), and only AFTER that does `broadcastGameState` push the per-player state including new hole cards + active positions.

For a client that's not under network pressure, this still works because socket.io delivers events in order on the same connection. But:

1. **`broadcastGameState` is `async` and we don't await it before returning.** It chains a `.catch(() => {})` and the timer callback ends. Is there any way the broadcast can be dropped or arrive AFTER game:new-hand?
2. **Cross-tab / cross-device:** if a client has the page in a backgrounded tab, the receive queue can desync from animation timers — but this is browser-internal, not socket.io.
3. **DealAnimation triggers on `game:new-hand`** (sets `dealTrigger`), but the player state needed to compute the deal animation comes from `broadcastGameState`. If new-hand arrives first and is processed synchronously (which it is), the effect runs BEFORE the next broadcastGameState arrives, with stale player positions.

I'm leaning toward "fix the order" + "client-side safety net" together. Concretely:

**Server change:** swap order in `handLifecycle.ts` — push the fresh game state to clients BEFORE emitting `game:new-hand`. New order:
1. `initializeHand()` — DB write
2. `broadcastGameState` — push fresh per-player state
3. `emitGameEvent(gameId, 'game:new-hand', ...)` — tell clients to start the deal animation

This guarantees the player positions and hole cards are in client state BEFORE the deal animation effect fires.

**Client change:** in `DealAnimation.tsx`, the empty-eligible early-return MUST still call `onComplete()`. Otherwise any future cause of "no eligible players at trigger time" will permanently hide cards. Belt-and-braces. Also add a 4s watchdog in `GameRoom.tsx`: when `game:new-hand` arrives, set a one-shot timeout that force-flips `betweenHands → false` if the animation hasn't cleared it.

#### Questions for you

1. **Server-side order swap:** safe? Any reason `broadcastGameState` should come AFTER `game:new-hand`? I can't think of one but you may know the history.
2. **Will swapping the order break the deal animation's UX timing?** The animation listens for `game:new-hand` and uses player positions from state. If positions arrive first, the animation will use the FRESH active list — which is what we want — but the user sees the chime first, then a brief pause, then the cards start flying. Currently the order is reversed (cards fly before state updates). What's actually correct here?
3. **Is there a same-tx race I'm missing?** `initializeHand()` writes hand state; if `broadcastGameState` then reads game/players, can it race with `initializeHand()` not being fully committed? It's outside the helper's transaction. Should we add a small "wait for visible" check, or is the implicit commit ordering enough?
4. **Multi-instance / horizontal scale (later):** if we ever run >1 backend instance, the event order across clients can vary regardless. Worth designing the client to be robust to any order from now? (Answer probably yes — but I want your call.)

### Bug B — Eliminated player misses showdown modal

CeceVsShaunV3, all-in hand where Cece pushed all-in pre-flop and got eliminated. Server fast-forwarded streets and emitted `game:showdown`. Shaun saw the animated street reveal and the showdown modal. Cece saw nothing — table disappeared, "You've Been Eliminated" full-screen card appeared within ~1s, no modal.

Root cause: `packages/frontend/src/pages/GameRoom.tsx` line 789:

```ts
if (gameState?.myPlayer.position === 'eliminated' && gameState?.status === 'in_progress') {
  return <EliminatedScreen />;   // ❌ unmounts the entire table
}
```

The early-return runs on every state update. The instant Cece is marked eliminated, the React tree below is unmounted including:
- The ongoing fast-forward street reveal `setTimeout`s
- The showdown modal that was about to render
- The table itself

Fix shape: drop the early-return. Render the table as normal even when eliminated. The per-seat plate already shows "ELIMINATED" status. Add a small dismissible toast/banner "You've been eliminated — click to leave" instead. Real poker sites do this; players want to see who beat them.

This is straightforward — I'm shipping it in Phase A. **I just want you to flag any non-obvious dependencies on the early-return path.** Grep finds it only in this one spot, but you may know of indirect coupling (e.g., does any other code assume the table is unmounted when position === eliminated?).

## Out of scope for this brief

- Pre-action button mojibake (my fault from yesterday's commit — JSX attribute strings don't interpret `\u2713` literals; fixed by wrapping in JSX expressions `symbol={"\u2713"}`)
- Header padding reduction (pure CSS)
- General "is the full audit-27 fix landing on production correctly" — confirmed yes by 18 hands of clean play.

## Files to read

- `packages/backend/src/services/handLifecycle.ts` (audit-27, your prior review)
- `packages/frontend/src/components/DealAnimation.tsx` (the early-return)
- `packages/frontend/src/pages/GameRoom.tsx` line 789 (eliminated early-return) + lines 472-624 (socket event handlers)
- `packages/frontend/src/components/PokerTable.tsx` `hideCards` derivation
- `MEMORY.md` F-03 silent-stall section (related family)

## Ask

Read, run any quick grep you want, give me a yes/no on Q1-Q4 plus any other gotchas on Bug A. Bug B is a sanity check — flag dependencies if any. I'll execute Phase A immediately and hold Phase B + C until your sign-off.
