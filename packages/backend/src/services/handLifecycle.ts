/**
 * handLifecycle — shared post-action lifecycle for the poker engine.
 *
 * BACKGROUND (Gerald audit-27, 2026-05-15):
 * Previously the post-action emit chain (game:action, game:fold-win /
 * game:showdown, game:next-hand-countdown, setTimeout(8s) → initializeHand
 * → game:new-hand, game:completed) lived ONLY inside the
 * `/api/games/:id/action` route handler. The turnTimer auto-action path
 * called `processAction()` directly and emitted only `game:updated` +
 * `broadcastGameState`. When an auto-action ended a hand (auto-fold that
 * happened to be the last unresolved actor → fold-win, or fast-forward
 * showdown), the DB was correctly closed but the frontend never received
 * fold-win/showdown and no next hand was ever scheduled. Table dies.
 *
 * That bug killed Hand 7→8 in the CeceAndShaunTest playtest.
 *
 * This module is the SINGLE post-action lifecycle path. Both the API
 * route handler and the turnTimer auto-action path call
 * `emitPostActionLifecycle()` after `processAction()` returns. Identical
 * behaviour for human and auto actions, modulo the `autoAction: true`
 * flag on `game:updated`.
 *
 * SAFETY GUARANTEES (Gerald audit-27):
 *  1. Lifecycle scheduling is deduped per COMPLETED handId, not gameId.
 *     If the human request and the auto-action race on the same hand-end
 *     (which can happen during the H-02 stale-action window), only ONE
 *     setTimeout(8s) → initializeHand fires.
 *  2. Inside the 8s setTimeout, before calling initializeHand, we
 *     re-read the game state and verify:
 *       - game still 'in_progress' (not cancelled mid-countdown)
 *       - game.currentHandId still points at the completed hand we're
 *         advancing from (not a newer hand already created by another
 *         path)
 *       - no non-completed hand already exists for this game
 *     If any check fails, we skip the new-hand init and just log.
 *  3. The `inflightAutoActions` Set in turnTimer.ts still protects the
 *     EXECUTION path; this module's `scheduledNextHands` Set protects the
 *     LIFECYCLE-SIDE-EFFECT path. Both are needed.
 *
 * SCALE NOTE: dedupe Sets are process-local. Railway runs one backend
 * instance per deploy, so this is safe today. Horizontal scale needs a
 * DB advisory lock or a persisted "next hand scheduled" marker on the
 * Game row.
 */

import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { emitGameEvent } from '../socket';
import { initializeHand } from './holdemGame';

// Dedupe key: the handId that just COMPLETED. While we have a pending
// setTimeout-driven next-hand init for that completed hand, no other
// caller can schedule another one.
const scheduledNextHands = new Set<string>();

/**
 * Shape of `processAction()` return value as it's consumed here. The
 * engine returns different fields depending on what happened; we treat
 * everything as optional and branch on what's present.
 */
export interface ProcessActionResult {
  action: string;
  // Normal-action fields (no hand-end):
  nextPlayer?: string;
  pot?: string;
  currentBet?: string;
  stage?: string;
  actionAmount?: string;
  actionBy?: string;
  // Hand-end fields:
  gameOver?: boolean;
  showdownResults?: any;
  foldWinResult?: {
    winnerId: string;
    winnerName: string;
    pot: string;
  };
  // Street-advance (no hand-end):
  nextStage?: string;
}

export interface PostActionContext {
  gameId: string;
  userId: string;
  action: string;
  /** True if this lifecycle is triggered by turnTimer auto-action (not a human request). */
  autoAction?: boolean;
  /**
   * The Hand.id at the moment the action was DISPATCHED (before
   * processAction ran). If processAction ends the hand, this is the
   * completed hand we're advancing from. Used as the lifecycle dedupe
   * key and the pre-flight re-check target.
   */
  completedHandId?: string;
}

/**
 * Run the post-action emit chain. Idempotent per completed hand by
 * design — calling twice with the same completedHandId schedules the
 * next hand only once.
 */
export async function emitPostActionLifecycle(
  ctx: PostActionContext,
  result: ProcessActionResult
): Promise<void> {
  const { gameId, userId, action, autoAction = false, completedHandId } = ctx;

  // ─────────────────────────────────────────────────────────────────
  // 1. game:action — ALWAYS emit, including for auto-actions. Frontend
  //    needs this for the action animation, sound, and turn indicator
  //    update. Previously turnTimer emitted only game:updated, which
  //    skipped the animation path. (Gerald audit-27.)
  // ─────────────────────────────────────────────────────────────────
  emitGameEvent(gameId, 'game:action', {
    gameId,
    action,
    userId,
    nextPlayer: result.nextPlayer ?? null,
    pot: result.pot ?? null,
    currentBet: result.currentBet ?? null,
    stage: result.stage ?? null,
    actionAmount: result.actionAmount ?? null,
    autoAction,
    timestamp: Date.now(),
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. broadcastGameState — only when the hand is still live. For
  //    hand-end results, the next-hand init handles its own broadcast.
  // ─────────────────────────────────────────────────────────────────
  if (!result.gameOver) {
    try {
      const gPlayers = await prisma.game.findUnique({
        where: { id: gameId },
        select: { players: { select: { userId: true } } },
      });
      if (gPlayers) {
        const { broadcastGameState } = await import('../socket');
        await broadcastGameState(gameId, gPlayers.players.map(p => p.userId)).catch(() => {});
      }
    } catch (err) {
      logger.warn('broadcastGameState (post-action) failed (non-fatal)', {
        gameId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. Game-over (closeGameInTx fired inside processAction) detection.
  //    Compose authoritative final-standings payload from MoneyEvent
  //    cashout rows so the Game Over screen shows correct winners,
  //    not the stale mid-hand snapshot. (Bug fixed 2026-05-13.)
  // ─────────────────────────────────────────────────────────────────
  let finalStandingsPayload: any = null;
  try {
    const postGame = await prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true },
    });
    if (postGame?.status === 'completed') {
      const cashouts = await prisma.moneyEvent.findMany({
        where: { gameId, eventType: { in: ['game_cashout', 'game_cancel_refund'] } },
        orderBy: { serverTime: 'asc' },
      });
      const userIds = Array.from(new Set(cashouts.map(c => c.userId)));
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      });
      const nameByUser = new Map(users.map(u => [u.id, u.username]));
      const totalByUser = new Map<string, bigint>();
      for (const c of cashouts) {
        totalByUser.set(c.userId, (totalByUser.get(c.userId) ?? 0n) + BigInt(c.amount));
      }
      const standings = Array.from(totalByUser.entries()).map(([uId, amount]) => ({
        userId: uId,
        username: nameByUser.get(uId) ?? uId.slice(-6),
        chipStack: amount.toString(),
      }));
      standings.sort((a, b) => Number(BigInt(b.chipStack) - BigInt(a.chipStack)));
      finalStandingsPayload = { gameId, standings };
    }
  } catch (err) {
    logger.warn('Failed to compose final standings (non-fatal)', {
      gameId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. Hand-end specific events + schedule next hand.
  // ─────────────────────────────────────────────────────────────────
  if (result.showdownResults) {
    emitGameEvent(gameId, 'game:showdown', {
      gameId,
      ...result.showdownResults,
    });
    scheduleNextHand(gameId, completedHandId, 'showdown');
  } else if (result.gameOver) {
    if (result.foldWinResult) {
      emitGameEvent(gameId, 'game:fold-win', {
        gameId,
        ...result.foldWinResult,
      });
    }
    emitGameEvent(gameId, 'game:updated', {
      gameId,
      action,
      userId,
      autoAction,
    });
    scheduleNextHand(gameId, completedHandId, 'fold-win');
  }
  // else: normal action — game:action already covered it.

  // ─────────────────────────────────────────────────────────────────
  // 5. Final standings (if game just ended). After hand events so
  //    Game Over screen sees the hand-end first.
  // ─────────────────────────────────────────────────────────────────
  if (finalStandingsPayload) {
    emitGameEvent(gameId, 'game:completed', finalStandingsPayload);
  }
}

/**
 * Schedule the 8s countdown + new-hand init. Idempotent per completed
 * handId.
 *
 * The countdown event fires immediately. The chime + initializeHand
 * fire together 8s later, after a pre-flight re-check that the game is
 * still in_progress and we're advancing from the expected hand.
 */
function scheduleNextHand(
  gameId: string,
  completedHandId: string | undefined,
  reason: 'showdown' | 'fold-win'
): void {
  // Defensive: if the engine somehow didn't tell us which hand
  // completed, fall back to gameId-level keying so we still dedupe
  // within the game. Better than letting duplicates through.
  const key = completedHandId ? `hand:${completedHandId}` : `game:${gameId}`;

  if (scheduledNextHands.has(key)) {
    logger.info('Next-hand init already scheduled — skipping duplicate', {
      gameId,
      completedHandId,
      reason,
    });
    return;
  }
  scheduledNextHands.add(key);

  logger.info('Starting 8s countdown before next hand', {
    gameId,
    completedHandId,
    reason,
  });
  emitGameEvent(gameId, 'game:next-hand-countdown', { gameId, seconds: 8 });

  setTimeout(async () => {
    try {
      // ─── Pre-flight re-check (Gerald audit-27) ─────────────────
      // 1. Game still in_progress
      // 2. currentHandId still the completed hand we're advancing from
      //    (some other path didn't already create a new hand)
      // 3. No non-completed hand exists for this game
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        select: { id: true, status: true, currentHandId: true },
      });

      if (!game) {
        logger.info('Next-hand init aborted: game not found', { gameId, completedHandId });
        return;
      }
      if (game.status !== 'in_progress') {
        logger.info('Next-hand init aborted: game no longer in_progress', {
          gameId,
          completedHandId,
          status: game.status,
        });
        return;
      }
      if (completedHandId && game.currentHandId && game.currentHandId !== completedHandId) {
        logger.info('Next-hand init aborted: currentHandId already moved past the completed hand', {
          gameId,
          completedHandId,
          currentHandId: game.currentHandId,
        });
        return;
      }
      const openHand = await prisma.hand.findFirst({
        where: { gameId, stage: { notIn: ['completed', 'showdown'] } },
        select: { id: true, handNumber: true, stage: true },
      });
      if (openHand) {
        logger.info('Next-hand init aborted: a non-completed hand already exists', {
          gameId,
          completedHandId,
          openHandId: openHand.id,
          openHandNumber: openHand.handNumber,
          openHandStage: openHand.stage,
        });
        return;
      }

      // ─── Pre-flight checks passed — fire chime, init, push state,
      //     THEN announce new hand. (Gerald audit-28 sign-off.) ─────────
      //
      // ORDER MATTERS. Previously the order was:
      //   chime → initializeHand → game:new-hand → broadcastGameState
      //
      // That allowed `game:new-hand` to arrive on a client BEFORE the
      // per-player state (positions reset to 'active', new hole cards).
      // DealAnimation's effect ran with stale `players` (all marked
      // folded/eliminated from the previous hand), found zero
      // eligible seats, early-returned without firing onComplete.
      // betweenHands stayed true forever → cards stayed hidden until
      // page reload. Reproduced 2026-05-15 in CeceVsShaunV3 hand 2:
      // Shaun saw a blank table while Cece saw cards normally (her
      // events arrived in the opposite order).
      //
      // New order: state lands BEFORE the trigger event, so the deal
      // animation always reads fresh positions / new hand id.
      logger.info('8s countdown finished, starting next hand + chime', {
        gameId,
        completedHandId,
        reason,
      });
      emitGameEvent(gameId, 'game:next-hand-chime', { gameId });
      await initializeHand(gameId);

      // Read the freshly-created hand for the event payload. Clients
      // use this as a deal-animation trigger key + correlation id, so
      // an animation can correlate with the game state it reads from
      // broadcastGameState. (Gerald audit-28 Q1 follow-up.)
      const refreshedGame = await prisma.game.findUnique({
        where: { id: gameId },
        select: {
          currentHandId: true,
          players: { select: { userId: true } },
        },
      });
      const newHandId = refreshedGame?.currentHandId ?? null;
      const playerIds = refreshedGame?.players.map(p => p.userId) || [];

      // Push fresh per-player state to every seated client BEFORE the
      // trigger event. Await it so we know clients have received it
      // before we announce the new hand.
      const { broadcastGameState } = await import('../socket');
      await broadcastGameState(gameId, playerIds).catch(err => {
        logger.warn('broadcastGameState before game:new-hand failed', {
          gameId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // NOW announce the new hand. Clients already have the state
      // they need to render the deal animation.
      emitGameEvent(gameId, 'game:new-hand', { gameId, handId: newHandId });
    } catch (err: any) {
      logger.error('Failed to start next hand', {
        gameId,
        completedHandId,
        reason,
        error: err?.message || String(err),
        stack: err?.stack,
      });
    } finally {
      // Always release the dedupe slot, success or failure. Hand-end
      // is a one-shot transition, so we never want a stuck claim.
      scheduledNextHands.delete(key);
    }
  }, 8_000);
}

/**
 * Test/debug helper — exposed for the gameplay test layer so the
 * regression test can assert "exactly one scheduled init per
 * completed hand".
 */
export function _internalScheduledNextHandsSnapshot(): string[] {
  return Array.from(scheduledNextHands);
}

/**
 * Test-only — wipe dedupe state between scenarios. NEVER call in
 * production paths.
 */
export function _internalResetLifecycleState(): void {
  scheduledNextHands.clear();
}
