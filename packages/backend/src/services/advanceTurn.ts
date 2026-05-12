/**
 * advanceTurn — shared helper for moving activePlayerIndex past
 * folded/eliminated/all_in seats and broadcasting state.
 *
 * Used by:
 *   - leaveGame (in_progress path): when a player leaves and they were
 *     the current active seat, the turn must advance immediately so
 *     the next player can act. Without this, the 30s turnTimer is the
 *     only thing that nudges the table forward, which Shaun saw as
 *     4–5 silent pauses after he left a hand. (Playtest 2026-05-12.)
 *
 *   - turnTimer (safety net): if the active seat is dead (eliminated
 *     or folded) for any reason, advance the turn without waiting the
 *     full TURN_TIMEOUT_MS. The turnTimer used to `continue;` on dead
 *     seats which left the hand stalled.
 *
 * This file deliberately stays small and transaction-aware: every
 * function takes the calling tx so the caller controls atomicity.
 */

import { logger } from '../utils/logger';

interface Seat {
  position: string;
  userId: string;
  seatIndex: number;
}

/**
 * Find the next seat index whose player is still allowed to act
 * (position === 'active'). Returns null when no such seat exists
 * (meaning everyone remaining is folded/eliminated/all_in — the
 * caller should fast-forward to showdown).
 */
export function findNextActiveSeatIndex(
  seats: Seat[],
  fromIndex: number
): number | null {
  const n = seats.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step++) {
    const i = (fromIndex + step) % n;
    if (seats[i].position === 'active') return i;
  }
  return null;
}

/**
 * Advance activePlayerIndex on the given hand to the next 'active'
 * seat. Returns the new index, or null if no active seat remains.
 *
 * IMPORTANT: this does NOT trigger showdown/fast-forward when no
 * active seat remains — that's the caller's responsibility (it
 * depends on context: leaveGame may want to close the game, the
 * turnTimer wants to run the showdown).
 */
export async function advanceActivePlayerInTx(
  tx: any,
  gameId: string,
  handId: string
): Promise<{ nextSeatIndex: number | null; advanced: boolean }> {
  const hand = await tx.hand.findUnique({ where: { id: handId } });
  if (!hand) return { nextSeatIndex: null, advanced: false };
  if (hand.stage === 'completed' || hand.stage === 'showdown') {
    return { nextSeatIndex: null, advanced: false };
  }

  const seats: Seat[] = await tx.gamePlayer.findMany({
    where: { gameId },
    orderBy: { seatIndex: 'asc' },
  });

  const currentIdx = hand.activePlayerIndex;
  const nextIdx = findNextActiveSeatIndex(seats, currentIdx);

  if (nextIdx === null) {
    return { nextSeatIndex: null, advanced: false };
  }
  if (nextIdx === currentIdx) {
    // The currently-active seat is itself the only active player —
    // nothing to advance. Caller decides what to do (this can happen
    // legitimately when one player goes all-in and one remains).
    return { nextSeatIndex: currentIdx, advanced: false };
  }

  await tx.hand.update({
    where: { id: handId },
    data: {
      activePlayerIndex: nextIdx,
      turnStartedAt: new Date(),
      // Bump the hand version so any in-flight optimistic guards see
      // the turn has moved. processAction's H-02 guard relies on this.
      version: { increment: 1 },
    },
  });

  logger.info('Turn advanced (leave/dead-seat skip)', {
    gameId,
    handId,
    from: currentIdx,
    to: nextIdx,
    fromUser: seats[currentIdx]?.userId?.slice(-6),
    toUser: seats[nextIdx]?.userId?.slice(-6),
  });

  return { nextSeatIndex: nextIdx, advanced: true };
}
