/**
 * Phase 9 follow-up [item 3] — off-table money ledger.
 *
 * Distinct from HandEvent (game/hand only) and ChipAudit (legacy off-table
 * audit table that we keep as the canonical balance ledger). This ledger
 * captures deposit/withdrawal lifecycle events with rich correlation data
 * (txHash, withdrawalId, depositId, authorizationId) so a dispute can be
 * traced end-to-end.
 *
 * Single entry point `recordMoneyEvent(tx, ...)` so callers don't have to
 * remember the schema. No FK to Game — events about deposits are not
 * game-scoped and must not fail FK constraints.
 */

import { logger } from '../utils/logger';

export const MONEY_EVENT_TYPES = [
  'deposit',
  'withdrawal_requested',
  'withdrawal_completed',
  'withdrawal_failed',
  'withdrawal_refund',
  'game_buy_in',
  'game_cashout',
  'game_cancel_refund',
  'admin_adjustment',
] as const;

export type MoneyEventType = (typeof MONEY_EVENT_TYPES)[number];

export interface RecordMoneyEventInput {
  userId: string;
  eventType: MoneyEventType;
  amount: bigint; // signed: positive = into user balance, negative = out
  balanceBefore?: bigint | null;
  balanceAfter?: bigint | null;
  gameId?: string | null;
  handId?: string | null;
  txHash?: string | null;
  withdrawalId?: string | null;
  depositId?: string | null;
  authorizationId?: string | null;
  payload?: Record<string, any>;
  correlationId?: string | null;
}

/**
 * Append a row to the MoneyEvent ledger inside the caller's transaction.
 */
export async function recordMoneyEvent(
  tx: any,
  input: RecordMoneyEventInput
): Promise<{ id: string }> {
  if (!input.userId) throw new Error('moneyLedger: userId is required');
  if (!MONEY_EVENT_TYPES.includes(input.eventType)) {
    throw new Error(`moneyLedger: unknown event type ${input.eventType}`);
  }
  const created = await tx.moneyEvent.create({
    data: {
      userId: input.userId,
      eventType: input.eventType,
      amount: BigInt(input.amount),
      balanceBefore: input.balanceBefore == null ? null : BigInt(input.balanceBefore),
      balanceAfter: input.balanceAfter == null ? null : BigInt(input.balanceAfter),
      gameId: input.gameId ?? null,
      handId: input.handId ?? null,
      txHash: input.txHash ?? null,
      withdrawalId: input.withdrawalId ?? null,
      depositId: input.depositId ?? null,
      authorizationId: input.authorizationId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      correlationId: input.correlationId ?? null,
    },
    select: { id: true },
  });
  logger.info('MoneyEvent', {
    userId: input.userId,
    type: input.eventType,
    amount: input.amount.toString(),
    txHash: input.txHash ?? undefined,
    withdrawalId: input.withdrawalId ?? undefined,
    correlationId: input.correlationId ?? undefined,
  });
  return created;
}
