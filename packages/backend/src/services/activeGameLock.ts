/**
 * Phase 10 [H-04] — Active-game money lock.
 *
 * A user cannot deposit or withdraw while seated at a poker table whose
 * status is 'waiting' OR 'in_progress' AND they still have a non-zero
 * `GamePlayer.chipStack`. A waiting table still has buy-in locked, so
 * blocking only on 'in_progress' was insufficient.
 *
 * Single helper used by:
 *   - processWithdrawal (inside the deduct-balance transaction)
 *   - createDepositChallenge (before issuing a nonce)
 *   - blockchain credit path (re-check before crediting; queue for manual
 *     review if the user joined a table after authorization but before
 *     confirmations landed)
 *
 * Returns null when the user is free to move money. Returns a structured
 * reason when they are not so callers can surface the same 409 code:
 *
 *   code: 'active_game_money_locked'
 */
import { prisma } from '../db/client';

export interface ActiveGameLockHit {
  code: 'active_game_money_locked';
  message: string;
  gameId: string;
  status: 'waiting' | 'in_progress';
  chipStack: string;
}

export type ActiveGameLockResult = null | ActiveGameLockHit;

const LOCKED_STATUSES = ['waiting', 'in_progress'] as const;

/**
 * Check if the user has any "money-locked" seat. Pass a Prisma transaction
 * client (`tx`) to compose this with a balance-mutation transaction so
 * there is no race between the check and the deduction.
 */
export async function checkActiveGameLock(
  client: { gamePlayer: { findFirst: (args: any) => Promise<any> } },
  userId: string
): Promise<ActiveGameLockResult> {
  if (!userId) return null;
  const seat = await client.gamePlayer.findFirst({
    where: {
      userId,
      chipStack: { gt: 0n },
      game: { status: { in: LOCKED_STATUSES as unknown as string[] } },
    },
    select: {
      gameId: true,
      chipStack: true,
      game: { select: { status: true } },
    },
  });
  if (!seat) return null;
  return {
    code: 'active_game_money_locked',
    message:
      'Cannot move money while seated at an active or waiting table. Leave the table to unlock your balance.',
    gameId: seat.gameId,
    status: seat.game.status as 'waiting' | 'in_progress',
    chipStack: BigInt(seat.chipStack ?? 0n).toString(),
  };
}

/**
 * Convenience wrapper that uses the global prisma client. Use the
 * `checkActiveGameLock(tx, userId)` form when composing inside a
 * transaction (preferred for write paths).
 */
export async function checkActiveGameLockGlobal(userId: string) {
  return checkActiveGameLock(prisma, userId);
}
