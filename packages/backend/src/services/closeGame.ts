/**
 * Phase 10 [H-01] — Canonical close-game helper.
 *
 * Background: Gerald's harness audit found that multiple paths refunded
 * `GamePlayer.chipStack` into off-table `ChipBalance` without:
 *   - zeroing the in-table chipStack (so chips were duplicated),
 *   - writing a `ChipAudit` row,
 *   - running inside a single transaction,
 *   - closing the active Hand row, leaving a stale `pot > 0` behind.
 *
 * This module provides ONE entry point that every close path uses:
 *   - natural game-over showdown    -> reason = 'natural_completion'
 *   - admin/cron stale cleanup      -> reason = 'stale_cleanup'
 *   - admin manual cancel           -> reason = 'admin_cancel'
 *   - creator pre-start cancel      -> reason = 'pre_start_cancel'
 *
 * Invariant after this runs (always):
 *   - Game.status        in {'completed', 'cancelled'}
 *   - GamePlayer.chipStack = 0 for every seat
 *   - Hand.stage         = 'completed' for any open hand (pot already
 *     attributed to refunds, so it is closed and conceptually empty)
 *   - sum(refund deltas) == pre-existing(sum(GamePlayer.chipStack) +
 *                                       open-hand.pot)
 *
 * Nothing in this helper credits new money. It only moves money that is
 * already in the system (table -> off-table).
 *
 * Refund policy:
 *   - 'natural_completion':
 *       Each player keeps their current chipStack (showdown already
 *       distributed the pot via processAction). Operation = 'game_cashout'.
 *       Open hand should already be 'completed' before this is called;
 *       we do NOT redistribute hand.pot here.
 *   - 'stale_cleanup' / 'admin_cancel' / 'pre_start_cancel':
 *       Each player gets back their own current chipStack PLUS their
 *       contributions to the open hand's pot (current-stage actions
 *       summed, then any earlier-stage contributions if the open hand
 *       has them). Pot is then zero. Operation = 'game_cancel_refund'.
 *
 * Authoritative ledger writes per refunded player:
 *   - ChipBalance row updated (increment by refundAmount)
 *   - GamePlayer.chipStack zeroed
 *   - ChipAudit row appended
 *   - MoneyEvent row appended (game_cashout or game_cancel_refund)
 *
 * One game.status flip + game.completedAt write at the end. All inside ONE
 * transaction so partial failure is impossible.
 */
import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { recordMoneyEvent } from './moneyLedger';
import { acquireUserMoneyMutex } from './userMoneyMutex';

export type CloseReason =
  | 'natural_completion'
  | 'stale_cleanup'
  | 'admin_cancel'
  | 'pre_start_cancel';

export interface CloseGameInput {
  gameId: string;
  reason: CloseReason;
  /** Optional human note recorded in the audit row. */
  notes?: string;
  /** Optional correlation id for tracing across tables. */
  correlationId?: string | null;
  /**
   * Optional list of user ids that should still be considered "winners"
   * for natural_completion (mostly for logs). Refunds work the same
   * regardless: each player gets their current chipStack.
   */
  winnerUserIds?: string[];
}

export interface ClosedPlayerSummary {
  userId: string;
  refundAmount: bigint;
  newBalance: bigint;
}

export interface CloseGameResult {
  gameId: string;
  reason: CloseReason;
  newStatus: 'completed' | 'cancelled';
  refundedPlayers: ClosedPlayerSummary[];
  totalRefunded: bigint;
}

/**
 * Decide the new game.status from the close reason.
 * - natural_completion         -> 'completed'  (showdown end)
 * - everything else (cancel)   -> 'cancelled'
 */
function statusForReason(reason: CloseReason): 'completed' | 'cancelled' {
  return reason === 'natural_completion' ? 'completed' : 'cancelled';
}

/**
 * Decide the audit/MoneyEvent operation/eventType.
 */
function operationForReason(reason: CloseReason): {
  chipAuditOp: string;
  moneyEvent: 'game_cashout' | 'game_cancel_refund';
} {
  if (reason === 'natural_completion') {
    return { chipAuditOp: 'game_cashout', moneyEvent: 'game_cashout' };
  }
  return { chipAuditOp: 'game_cancel_refund', moneyEvent: 'game_cancel_refund' };
}

/**
 * The core helper. Closes a game atomically.
 *
 * MUST run with the calling transaction passed in via `tx` so callers can
 * compose this with their own work (e.g. cron job iterating multiple games).
 */
export async function closeGameInTx(
  tx: any,
  input: CloseGameInput
): Promise<CloseGameResult> {
  const { gameId, reason } = input;
  const newStatus = statusForReason(reason);
  const { chipAuditOp, moneyEvent } = operationForReason(reason);

  const game = await tx.game.findUnique({
    where: { id: gameId },
    include: {
      players: { orderBy: { seatIndex: 'asc' } },
      hands: {
        where: { stage: { not: 'completed' } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!game) throw new Error(`closeGame: game not found: ${gameId}`);

  if (game.status === 'completed' || game.status === 'cancelled') {
    // Idempotent no-op. Caller may have raced with another close path.
    logger.info('closeGame: game already closed', {
      gameId,
      currentStatus: game.status,
      reason,
    });
    return {
      gameId,
      reason,
      newStatus: game.status as 'completed' | 'cancelled',
      refundedPlayers: [],
      totalRefunded: 0n,
    };
  }

  // For cancel paths: figure out per-user pot contributions from the
  // current open hand so we refund stake-locked chips too.
  // For natural_completion: pot has already been awarded by showdown
  // (the open hand is already 'completed'), so this stays at 0 each.
  const potContributions = new Map<string, bigint>();
  const openHand = game.hands[0]; // may be undefined if no open hand
  if (reason !== 'natural_completion' && openHand) {
    const actions = await tx.handAction.findMany({
      where: { handId: openHand.id },
      select: { userId: true, amount: true },
    });
    for (const a of actions) {
      const amt = a.amount == null ? 0n : BigInt(a.amount);
      if (amt <= 0n) continue;
      potContributions.set(
        a.userId,
        (potContributions.get(a.userId) ?? 0n) + amt
      );
    }
  }

  const refundedPlayers: ClosedPlayerSummary[] = [];
  let totalRefunded = 0n;

  // Phase 10 [H-04] hardening: acquire the per-user money mutex for every
  // player in deterministic order BEFORE any balance write. Stable order
  // (userId asc) avoids deadlocks if two close paths race for overlapping
  // user sets.
  const sortedPlayers = game.players
    .slice()
    .sort((a: any, b: any) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  for (const player of sortedPlayers) {
    await acquireUserMoneyMutex(tx, player.userId);
  }

  for (const player of game.players) {
    const stack = BigInt(player.chipStack ?? 0n);
    const potShare = potContributions.get(player.userId) ?? 0n;
    const refund = stack + potShare;

    if (refund <= 0n) {
      // Still zero the stack defensively if it was non-zero somehow,
      // which it isn't here. No money to move.
      continue;
    }

    const beforeRow = await tx.chipBalance.findUnique({
      where: { userId: player.userId },
    });
    if (!beforeRow) {
      // Hard fail: a player without a ChipBalance row should not exist.
      throw new Error(
        `closeGame: missing ChipBalance for user ${player.userId} in game ${gameId}`
      );
    }
    const afterRow = await tx.chipBalance.update({
      where: { userId: player.userId },
      data: { chips: { increment: refund } },
    });

    await tx.gamePlayer.update({
      where: { id: player.id },
      data: { chipStack: 0n },
    });

    await tx.chipAudit.create({
      data: {
        userId: player.userId,
        operation: chipAuditOp,
        amountDelta: refund,
        balanceBefore: beforeRow.chips,
        balanceAfter: afterRow.chips,
        reference: gameId,
        notes:
          input.notes ??
          `${reason}: ${stack.toString()} stack + ${potShare.toString()} pot share`,
      },
    });

    await recordMoneyEvent(tx, {
      userId: player.userId,
      eventType: moneyEvent,
      amount: refund,
      balanceBefore: beforeRow.chips,
      balanceAfter: afterRow.chips,
      gameId,
      handId: openHand?.id ?? null,
      correlationId: input.correlationId ?? `close:${gameId}`,
      payload: {
        reason,
        stackPart: stack.toString(),
        potSharePart: potShare.toString(),
      },
    });

    refundedPlayers.push({
      userId: player.userId,
      refundAmount: refund,
      newBalance: afterRow.chips,
    });
    totalRefunded += refund;
  }

  // Close any open hand. We zero the pot since refund already accounts for
  // it (or it was attributed at showdown for natural_completion).
  if (openHand) {
    await tx.hand.update({
      where: { id: openHand.id },
      data: {
        stage: 'completed',
        pot: 0n,
        completedAt: openHand.completedAt ?? new Date(),
      },
    });
  }

  await tx.game.update({
    where: { id: gameId },
    data: {
      status: newStatus,
      completedAt: new Date(),
    },
  });

  logger.info('Game closed', {
    gameId,
    reason,
    newStatus,
    refundedPlayers: refundedPlayers.length,
    totalRefunded: totalRefunded.toString(),
  });

  return { gameId, reason, newStatus, refundedPlayers, totalRefunded };
}

/**
 * Convenience wrapper: opens its own transaction.
 */
export async function closeGame(input: CloseGameInput): Promise<CloseGameResult> {
  return prisma.$transaction(async (tx) => closeGameInTx(tx, input));
}
