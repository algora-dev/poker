/**
 * Phase 10 [H-04] — Active-game money lock.
 *
 * A user cannot deposit or withdraw while seated at a poker table whose
 * status is 'waiting' OR 'in_progress'. The rule is "seated at an
 * active/waiting table", NOT "has chips on the table":
 *
 *   - All-in players have chipStack=0 mid-hand but are still in the hand;
 *     they must stay locked until the game closes.
 *   - Folded players are still seated (the next hand will deal them in)
 *     and stay locked.
 *   - Eliminated players are kept locked too — fail-closed default. They
 *     unlock when closeGame runs and removes them via the cancel/cashout
 *     path. If an admin needs to unlock an eliminated player early, that's
 *     an operational override, not a user-facing flow.
 *
 * Single helper used by:
 *   - processWithdrawal (inside the deduct-balance transaction)
 *   - createGame / joinGame (inside the buy-in deduct transaction)
 *   - createDepositChallenge (before issuing a nonce)
 *   - authorizeDeposit (re-check at signed submit time)
 *   - blockchain credit path (re-check inside the credit transaction)
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
  position: string;
}

export type ActiveGameLockResult = null | ActiveGameLockHit;

const LOCKED_STATUSES = ['waiting', 'in_progress'] as const;

/**
 * Check if the user has any seat at a waiting/in-progress game. Pass a
 * Prisma transaction client (`tx`) to compose this with a balance-mutation
 * transaction so there is no race between the check and the deduction.
 *
 * Phase 10 [H-04] hardening: the rule is "seated", not "has chips". A
 * player who is all-in (`chipStack=0` but still in the hand), folded but
 * seated for the next hand, or even eliminated but not yet released,
 * stays locked until the game closes via closeGame.
 */
export async function checkActiveGameLock(
  client: { gamePlayer: { findFirst: (args: any) => Promise<any> } },
  userId: string
): Promise<ActiveGameLockResult> {
  if (!userId) return null;
  const seat = await client.gamePlayer.findFirst({
    where: {
      userId,
      game: { status: { in: LOCKED_STATUSES as unknown as string[] } },
    },
    select: {
      gameId: true,
      chipStack: true,
      position: true,
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
    position: seat.position ?? 'unknown',
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
