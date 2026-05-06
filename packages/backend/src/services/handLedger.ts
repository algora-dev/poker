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
 * Append a single event to the HandEvent ledger. Caller passes a Prisma
 * transaction client (`tx`) so the event commits atomically with whatever
 * state mutation it describes.
 *
 * Sequence number assignment: per (gameId, handId) max + 1. Inside a
 * transaction this is race-safe because the Hand row is implicitly locked by
 * the action's other writes. For game-level events (handId=null) we still
 * use per-game ordering.
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
  // Privacy gate: refuse to write hole cards in mid-hand events.
  if (
    PRIVATE_DURING_HAND.has(input.eventType) &&
    looksLikePrivateCards(input.payload)
  ) {
    throw new Error(
      `handLedger: event ${input.eventType} payload contains private cards; ` +
        'hole cards must not appear in mid-hand events'
    );
  }

  // Determine next sequence number for this (gameId, handId) bucket.
  // Postgres treats null handId values as distinct, so the unique index
  // (gameId, handId, sequenceNumber) does not collide between buckets.
  const last = await tx.handEvent.findFirst({
    where: { gameId: input.gameId, handId: input.handId ?? null },
    orderBy: { sequenceNumber: 'desc' },
    select: { sequenceNumber: true },
  });
  const sequenceNumber = (last?.sequenceNumber ?? 0) + 1;

  const created = await tx.handEvent.create({
    data: {
      gameId: input.gameId,
      handId: input.handId ?? null,
      userId: input.userId ?? null,
      sequenceNumber,
      eventType: input.eventType,
      payload: JSON.stringify(input.payload ?? {}),
      correlationId: input.correlationId ?? null,
    },
    select: { id: true, sequenceNumber: true },
  });

  // Lightweight breadcrumb in normal logs so operators can grep without
  // querying the ledger. The ledger row IS the source of truth.
  logger.info('HandEvent', {
    gameId: input.gameId,
    handId: input.handId ?? null,
    seq: sequenceNumber,
    type: input.eventType,
    cor: input.correlationId ?? undefined,
  });

  return created;
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
