/**
 * Phase 7 [M-05] — append-only hand/game event ledger.
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 7:
 *
 *   "Add an append-only hand/game event ledger, separate from normal app
 *    logs. Each event should include game id, hand id, user id where
 *    applicable, server timestamp, sequence number, and correlation id.
 *    Do not expose private cards in public logs during an active hand.
 *    Store enough data after completion to reconstruct the hand internally.
 *    Log pot allocation proof: eligible players, winning hand rank, side
 *    pot amount, winner shares, remainder allocation."
 *
 * This module is the single entry point for writing rows to the HandEvent
 * table. Callers MUST go through `recordHandEvent` so the sequence number
 * and field hygiene (no private cards mid-hand) are enforced uniformly.
 *
 * Storage: HandEvent rows are append-only. The Prisma model exposes only
 * `create` semantics from this module — there is no update/delete path.
 */

import { logger } from '../utils/logger';

/**
 * Canonical event types. Adding a new type? Add it here AND document it
 * below. Tests assert this list against the schema audit checklist.
 */
export const PHASE7_EVENT_TYPES = [
  'game_created',
  'player_joined',
  'player_left', // also used for cashout when leaving mid-game
  'hand_started',
  'blinds_posted',
  'deck_committed', // hash/commitment of the shuffled deck before deal
  'action_received', // raw inbound action request (before validation)
  'action_applied', // committed action with before/after stack and pot
  'street_advanced', // flop/turn/river dealt
  'side_pots_built',
  'showdown_evaluated',
  'pot_awarded',
  'hand_completed',
  'game_completed',
  'game_cancelled',
  'deposit',
  'withdrawal',
  'refund',
  'admin_adjustment',
] as const;

export type HandEventType = (typeof PHASE7_EVENT_TYPES)[number];

/**
 * Event types that occur DURING an active hand (i.e. before stage='completed').
 * Payloads for these MUST NOT include private hole cards. Hand-completion
 * events MAY include hole cards once the hand is over.
 */
const PRIVATE_DURING_HAND: ReadonlySet<HandEventType> = new Set<HandEventType>([
  'hand_started',
  'blinds_posted',
  'deck_committed',
  'action_received',
  'action_applied',
  'street_advanced',
]);

/**
 * Recursively check a payload for keys that look like private hole-card data.
 * The check is conservative: any key named `holeCards`, `cards`, or `hole`
 * (case-insensitive) at any depth fails for in-flight events.
 */
function looksLikePrivateCards(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const stack: any[] = [payload];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const k of Object.keys(cur)) {
      const lower = k.toLowerCase();
      if (lower === 'holecards' || lower === 'hole' || lower === 'cards') {
        return true;
      }
      if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
    }
  }
  return false;
}

export interface RecordHandEventInput {
  gameId: string;
  handId?: string | null;
  userId?: string | null;
  eventType: HandEventType;
  payload?: Record<string, any>;
  correlationId?: string | null;
}

/**
 * Build the canonical scopeId used by the unique sequence index. Hand-scoped
 * events live in `hand:<handId>`; game-level events live in `game:<gameId>`.
 */
export function handLedgerScopeId(input: { gameId: string; handId?: string | null }): string {
  if (input.handId) return `hand:${input.handId}`;
  return `game:${input.gameId}`;
}

/**
 * Append a single event to the HandEvent ledger. Caller passes a Prisma
 * transaction client (`tx`) so the event commits atomically with whatever
 * state mutation it describes.
 *
 * Phase 9 follow-up [item 4]: sequence-number safety. We retry on the
 * unique-constraint violation that the new (scopeId, sequenceNumber)
 * unique index throws when two concurrent writers race. Each retry
 * re-reads max(sequence) and inserts at max+1. Bounded retries keep this
 * race-resilient without holding a long lock.
 *
 * Throws if a private-cards leak is detected for an in-flight event type.
 */
export async function recordHandEvent(
  tx: any,
  input: RecordHandEventInput
): Promise<{ id: string; sequenceNumber: number }> {
  if (!input.gameId) {
    throw new Error('handLedger: gameId is required');
  }
  if (!PHASE7_EVENT_TYPES.includes(input.eventType)) {
    throw new Error(`handLedger: unknown event type ${input.eventType}`);
  }
  if (
    PRIVATE_DURING_HAND.has(input.eventType) &&
    looksLikePrivateCards(input.payload)
  ) {
    throw new Error(
      `handLedger: event ${input.eventType} payload contains private cards; ` +
        'hole cards must not appear in mid-hand events'
    );
  }

  const scopeId = handLedgerScopeId({ gameId: input.gameId, handId: input.handId ?? null });

  // Retry loop: on unique-constraint conflict, re-read max+1 and try again.
  // The (scopeId, sequenceNumber) unique index makes the conflict detectable.
  // 5 retries is enough for any realistic concurrency on a single scope.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await tx.handEvent.findFirst({
      where: { scopeId },
      orderBy: { sequenceNumber: 'desc' },
      select: { sequenceNumber: true },
    });
    const sequenceNumber = (last?.sequenceNumber ?? 0) + 1;
    try {
      const created = await tx.handEvent.create({
        data: {
          gameId: input.gameId,
          handId: input.handId ?? null,
          userId: input.userId ?? null,
          scopeId,
          sequenceNumber,
          eventType: input.eventType,
          payload: JSON.stringify(input.payload ?? {}),
          correlationId: input.correlationId ?? null,
        },
        select: { id: true, sequenceNumber: true },
      });
      logger.info('HandEvent', {
        scopeId,
        seq: sequenceNumber,
        type: input.eventType,
        cor: input.correlationId ?? undefined,
      });
      return created;
    } catch (err: any) {
      lastErr = err;
      // P2002 = Prisma unique constraint violation. Retry with a fresh max.
      if (err?.code === 'P2002' || /Unique constraint/i.test(err?.message ?? '')) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `handLedger: failed to allocate sequence after 5 attempts on scope ${scopeId}: ${lastErr?.message ?? 'unknown'}`
  );
}

/**
 * Convenience: build a deck commitment payload (hash) WITHOUT exposing the
 * deck order. Use this when emitting `deck_committed` so the dealt order is
 * provable post-hand without leaking it during play.
 */
export async function buildDeckCommitment(deckJson: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(deckJson, 'utf8').digest('hex');
}
