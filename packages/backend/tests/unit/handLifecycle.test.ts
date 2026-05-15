/**
 * Phase audit-27 (CeceAndShaunTest freeze) — handLifecycle.ts regression tests.
 *
 * Bug being prevented:
 *   When turnTimer auto-acted a player and that action happened to be the
 *   last unresolved actor on a betting round (auto-fold becomes a fold-win,
 *   or auto-action triggers fast-forward showdown), the hand correctly
 *   completed in the DB but the frontend never received the fold-win /
 *   showdown event and no setTimeout-driven next-hand init fired. Table
 *   died. Hand 7 → Hand 8 freeze in CeceAndShaunTest playtest 2026-05-15.
 *
 * Fix shape: API route + turnTimer both call emitPostActionLifecycle()
 * which emits the full chain (game:action, game:fold-win/showdown,
 * countdown, schedule next-hand init) with dedupe per completed handId.
 *
 * These tests assert:
 *   1. Auto-action fold-win → emits game:action, game:fold-win,
 *      game:next-hand-countdown, and schedules exactly ONE next-hand init.
 *   2. Auto-action showdown → emits game:action, game:showdown,
 *      game:next-hand-countdown, and schedules exactly ONE next-hand init.
 *   3. Calling emitPostActionLifecycle TWICE for the same completedHandId
 *      (simulating human + auto-action race) schedules ONLY ONE next-hand
 *      init, not two.
 *   4. Pre-flight re-check inside the setTimeout aborts if the game is no
 *      longer in_progress.
 *   5. Pre-flight re-check inside the setTimeout aborts if a new hand was
 *      already created by another path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── mocks (hoisted before module loads) ─────────────────────────────

const emitGameEventMock = vi.fn();
const broadcastGameStateMock = vi.fn(async () => undefined);
const initializeHandMock = vi.fn(async () => undefined);

vi.mock('../../src/socket', () => ({
  emitGameEvent: (...args: any[]) => emitGameEventMock(...args),
  broadcastGameState: (...args: any[]) => broadcastGameStateMock(...args),
  emitBalanceUpdate: vi.fn(),
  checkGameRoomJoin: vi.fn(),
}));

vi.mock('../../src/services/holdemGame', () => ({
  initializeHand: (...args: any[]) => initializeHandMock(...args),
}));

// In-memory game/hand store the prisma mock reads from.
interface Store {
  game: { id: string; status: string; currentHandId: string | null } | null;
  openHand: { id: string; handNumber: number; stage: string } | null;
  players: { userId: string }[];
}
const store: Store = { game: null, openHand: null, players: [] };

vi.mock('../../src/db/client', () => ({
  prisma: {
    game: {
      findUnique: vi.fn(async (args: any) => {
        if (!store.game) return null;
        // Honour Prisma select shape — return only requested fields.
        if (args?.select) {
          const out: any = {};
          if (args.select.id) out.id = store.game.id;
          if (args.select.status) out.status = store.game.status;
          if (args.select.currentHandId) out.currentHandId = store.game.currentHandId;
          if (args.select.players) out.players = store.players.map(p => ({ userId: p.userId }));
          return out;
        }
        return { ...store.game, players: store.players };
      }),
    },
    hand: {
      findFirst: vi.fn(async () => store.openHand),
    },
    moneyEvent: {
      findMany: vi.fn(async () => []),
    },
    user: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── helpers ─────────────────────────────────────────────────────────

const FAKE_GAME_ID = 'g_test_lifecycle';
const FAKE_HAND_ID = 'h_test_completed_1';

function resetStore() {
  store.game = { id: FAKE_GAME_ID, status: 'in_progress', currentHandId: FAKE_HAND_ID };
  store.openHand = null; // no open hand by default — the completed hand is gone
  store.players = [{ userId: 'u1' }, { userId: 'u2' }];
}

async function runLifecycle(result: any, opts: { completedHandId?: string; autoAction?: boolean } = {}) {
  const { emitPostActionLifecycle, _internalResetLifecycleState } =
    await import('../../src/services/handLifecycle');
  _internalResetLifecycleState();
  await emitPostActionLifecycle(
    {
      gameId: FAKE_GAME_ID,
      userId: 'u_actor',
      action: 'fold',
      autoAction: opts.autoAction ?? false,
      completedHandId: opts.completedHandId ?? FAKE_HAND_ID,
    },
    result
  );
}

function emittedEvents(): string[] {
  return emitGameEventMock.mock.calls.map(c => c[1] as string);
}

// ─── tests ───────────────────────────────────────────────────────────

describe('handLifecycle.emitPostActionLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emitGameEventMock.mockClear();
    broadcastGameStateMock.mockClear();
    initializeHandMock.mockClear();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-action fold-win → emits game:action, game:fold-win, countdown, schedules ONE init', async () => {
    await runLifecycle(
      {
        action: 'fold',
        gameOver: true,
        foldWinResult: {
          winnerId: 'u_winner',
          winnerName: 'winner',
          pot: '5000000',
        },
      },
      { autoAction: true }
    );

    const events = emittedEvents();
    expect(events).toContain('game:action');
    expect(events).toContain('game:fold-win');
    expect(events).toContain('game:updated');
    expect(events).toContain('game:next-hand-countdown');
    // Not yet — countdown is pending.
    expect(events).not.toContain('game:new-hand');
    expect(initializeHandMock).not.toHaveBeenCalled();

    // game:action payload must carry the autoAction flag so the frontend
    // can play the timer-fired animation.
    const actionCall = emitGameEventMock.mock.calls.find(c => c[1] === 'game:action');
    expect(actionCall?.[2]?.autoAction).toBe(true);

    // Advance the 8s timer.
    await vi.advanceTimersByTimeAsync(8_000);

    expect(initializeHandMock).toHaveBeenCalledTimes(1);
    expect(emittedEvents()).toContain('game:new-hand');
    expect(emittedEvents()).toContain('game:next-hand-chime');
  });

  it('auto-action showdown → emits game:action, game:showdown, countdown, schedules ONE init', async () => {
    await runLifecycle(
      {
        action: 'call',
        gameOver: true,
        showdownResults: {
          winners: [{ userId: 'u_winner', amount: '5000000' }],
          potTotal: '5000000',
        },
      },
      { autoAction: true }
    );

    const events = emittedEvents();
    expect(events).toContain('game:action');
    expect(events).toContain('game:showdown');
    expect(events).toContain('game:next-hand-countdown');
    expect(events).not.toContain('game:new-hand');

    await vi.advanceTimersByTimeAsync(8_000);

    expect(initializeHandMock).toHaveBeenCalledTimes(1);
    expect(emittedEvents()).toContain('game:new-hand');
  });

  it('TWO calls for the same completedHandId → exactly ONE next-hand init', async () => {
    // Simulates the race: human action ends the hand AND turnTimer
    // auto-action also fires for the same hand (the H-02 version-guard
    // window). Both paths invoke the lifecycle helper. The dedupe must
    // ensure only one setTimeout fires initializeHand.
    const { emitPostActionLifecycle, _internalResetLifecycleState } =
      await import('../../src/services/handLifecycle');
    _internalResetLifecycleState();

    const foldWinResult = {
      action: 'fold',
      gameOver: true,
      foldWinResult: { winnerId: 'u_winner', winnerName: 'winner', pot: '5000000' },
    };

    await emitPostActionLifecycle(
      { gameId: FAKE_GAME_ID, userId: 'u_actor', action: 'fold', completedHandId: FAKE_HAND_ID },
      foldWinResult
    );
    await emitPostActionLifecycle(
      { gameId: FAKE_GAME_ID, userId: 'u_actor', action: 'fold', autoAction: true, completedHandId: FAKE_HAND_ID },
      foldWinResult
    );

    await vi.advanceTimersByTimeAsync(8_000);

    expect(initializeHandMock).toHaveBeenCalledTimes(1);
    // game:new-hand fired exactly once.
    expect(emittedEvents().filter(e => e === 'game:new-hand')).toHaveLength(1);
  });

  it('pre-flight: aborts next-hand init if game is no longer in_progress', async () => {
    await runLifecycle({
      action: 'fold',
      gameOver: true,
      foldWinResult: { winnerId: 'u_winner', winnerName: 'winner', pot: '5000000' },
    });

    // Simulate the game being cancelled during the countdown.
    store.game = { id: FAKE_GAME_ID, status: 'cancelled', currentHandId: FAKE_HAND_ID };

    await vi.advanceTimersByTimeAsync(8_000);

    expect(initializeHandMock).not.toHaveBeenCalled();
    expect(emittedEvents()).not.toContain('game:new-hand');
  });

  it('pre-flight: aborts next-hand init if a non-completed hand already exists', async () => {
    await runLifecycle({
      action: 'fold',
      gameOver: true,
      foldWinResult: { winnerId: 'u_winner', winnerName: 'winner', pot: '5000000' },
    });

    // Simulate another path already creating the next hand.
    store.openHand = { id: 'h_next', handNumber: 8, stage: 'preflop' };

    await vi.advanceTimersByTimeAsync(8_000);

    expect(initializeHandMock).not.toHaveBeenCalled();
    expect(emittedEvents()).not.toContain('game:new-hand');
  });

  it('pre-flight: aborts if currentHandId moved past the completed hand', async () => {
    await runLifecycle({
      action: 'fold',
      gameOver: true,
      foldWinResult: { winnerId: 'u_winner', winnerName: 'winner', pot: '5000000' },
    });

    // Some other path advanced past the hand we were scheduling for.
    store.game = { id: FAKE_GAME_ID, status: 'in_progress', currentHandId: 'h_different' };

    await vi.advanceTimersByTimeAsync(8_000);

    expect(initializeHandMock).not.toHaveBeenCalled();
    expect(emittedEvents()).not.toContain('game:new-hand');
  });

  it('normal action (not gameOver) → emits game:action only, no countdown', async () => {
    await runLifecycle({
      action: 'call',
      nextPlayer: 'u2',
      pot: '500000',
      currentBet: '100000',
      stage: 'flop',
    });

    const events = emittedEvents();
    expect(events).toContain('game:action');
    expect(events).not.toContain('game:fold-win');
    expect(events).not.toContain('game:showdown');
    expect(events).not.toContain('game:next-hand-countdown');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(initializeHandMock).not.toHaveBeenCalled();
  });

  // Gerald audit-28 (CeceVsShaunV3 hand 2 missing-cards bug). The
  // event order on the next-hand init must be:
  //   chime → initializeHand → broadcastGameState → game:new-hand
  // Previously broadcastGameState came AFTER game:new-hand, allowing
  // some clients to receive the trigger event before the state it
  // depends on. DealAnimation then saw stale (folded/eliminated) seats
  // and aborted without firing onComplete, leaving betweenHands stuck
  // and cards hidden until page reload.
  it('audit-28 ordering: broadcastGameState must run BEFORE game:new-hand', async () => {
    await runLifecycle(
      {
        action: 'fold',
        gameOver: true,
        foldWinResult: { winnerId: 'u_winner', winnerName: 'winner', pot: '5000000' },
      },
      { autoAction: true }
    );

    // Track in which order initializeHand, broadcastGameState, and
    // game:new-hand fired across the 8s window.
    const callOrder: string[] = [];
    initializeHandMock.mockImplementationOnce(async () => {
      callOrder.push('initializeHand');
    });
    broadcastGameStateMock.mockImplementationOnce(async () => {
      callOrder.push('broadcastGameState');
    });
    const origEmit = emitGameEventMock.getMockImplementation();
    emitGameEventMock.mockImplementation((...args: any[]) => {
      if (args[1] === 'game:new-hand') callOrder.push('game:new-hand');
      return origEmit?.(...args);
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(callOrder).toEqual(['initializeHand', 'broadcastGameState', 'game:new-hand']);
  });

  it('audit-28: game:new-hand payload carries the new handId', async () => {
    // Server populates currentHandId during initializeHand. The test
    // store is reset each beforeEach() so currentHandId is the
    // FAKE_HAND_ID; in a real run it would be the freshly-created hand.
    // We assert that whatever the post-init currentHandId is, it ends
    // up in the game:new-hand payload — not null/undefined — so the
    // client can correlate the deal animation with the state it reads.
    await runLifecycle(
      {
        action: 'fold',
        gameOver: true,
        foldWinResult: { winnerId: 'u_winner', winnerName: 'winner', pot: '5000000' },
      },
      { autoAction: true }
    );

    await vi.advanceTimersByTimeAsync(8_000);

    const newHandCall = emitGameEventMock.mock.calls.find(c => c[1] === 'game:new-hand');
    expect(newHandCall).toBeDefined();
    expect(newHandCall?.[2]).toMatchObject({
      gameId: FAKE_GAME_ID,
      handId: FAKE_HAND_ID,
    });
  });
});
