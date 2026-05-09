/**
 * Pure position resolver for poker test scripts.
 *
 * Given the current game state (dealer seat, total seated count, set of
 * non-eliminated seats), resolves abstract positions like 'BTN', 'SB',
 * 'BB', 'UTG', 'HJ', 'CO' to concrete seat indices.
 *
 * Per Gerald's review (audit 20 Q2): test-side derivation, no production
 * state-shape change. The current state shape already exposes
 * dealerSeatIndex, sbSeatIndex, bbSeatIndex, and player.seatIndex, but
 * tests find it more readable to write 'BTN'/'SB'/'BB' than seat numbers.
 *
 * Heads-up special case: dealer is SB. Order on each street is documented
 * in `holdemGame.ts`; we mirror its contract here.
 */

export type AbstractPosition =
  | 'BTN'
  | 'SB'
  | 'BB'
  | 'UTG'
  | 'UTG+1'
  | 'UTG+2'
  | 'MP'
  | 'MP+1'
  | 'HJ'
  | 'CO';

export interface PositionContext {
  /** Seat index of the dealer (BTN). */
  dealerSeatIndex: number;
  /** All seats currently in the hand (not eliminated/empty). Order doesn't matter. */
  liveSeatIndices: number[];
  /** Total seats configured at the table (for modulo math). */
  totalSeats: number;
}

/**
 * Resolve an abstract position to a concrete seat index given the dealer
 * and the live seats in the hand. Returns -1 if the position doesn't
 * apply at this seat count (e.g. 'UTG+2' at a 3-handed table).
 */
export function resolvePosition(pos: AbstractPosition, ctx: PositionContext): number {
  const { dealerSeatIndex, liveSeatIndices, totalSeats } = ctx;
  if (liveSeatIndices.length < 2) {
    throw new Error(`resolvePosition: need at least 2 live seats, got ${liveSeatIndices.length}`);
  }

  // Walk live seats clockwise from the dealer; collect them in canonical
  // order: BTN, SB, BB, UTG, UTG+1, UTG+2, MP, MP+1, HJ, CO. The exact
  // labels for middle seats vary by player count; we match the WSOP
  // convention used by most live tooling.
  const seatsInOrder: number[] = [];
  for (let i = 0; i < totalSeats; i++) {
    const candidate = (dealerSeatIndex + i) % totalSeats;
    if (liveSeatIndices.includes(candidate)) {
      seatsInOrder.push(candidate);
    }
  }
  // seatsInOrder[0] = BTN, seatsInOrder[1] = SB, seatsInOrder[2] = BB, ...
  const n = seatsInOrder.length;

  // Heads-up: BTN === SB by convention.
  if (n === 2) {
    if (pos === 'BTN' || pos === 'SB') return seatsInOrder[0];
    if (pos === 'BB') return seatsInOrder[1];
    return -1;
  }

  // ≥ 3 players: BTN, SB, BB, then early/middle/late labels.
  switch (pos) {
    case 'BTN': return seatsInOrder[0];
    case 'SB':  return seatsInOrder[1];
    case 'BB':  return seatsInOrder[2];
  }

  // Late position labels (HJ, CO) are relative to the BTN going backwards.
  if (pos === 'CO' && n >= 4) return seatsInOrder[n - 1];          // seat just before BTN clockwise = last in ring
  if (pos === 'HJ' && n >= 5) return seatsInOrder[n - 2];

  // Early/middle position labels (UTG, UTG+1, UTG+2, MP, MP+1) start
  // immediately after BB.
  // UTG = seatsInOrder[3]; UTG+1 = [4]; etc.
  const earlyOffsets: Record<string, number> = {
    'UTG': 3,
    'UTG+1': 4,
    'UTG+2': 5,
    'MP': 5,
    'MP+1': 6,
  };
  const idx = earlyOffsets[pos];
  if (idx === undefined) return -1;
  // Don't collide with HJ/CO.
  if (idx >= n) return -1;
  // For 6-handed: UTG=3, MP=4, CO=5, but the rule above puts HJ at n-2=4
  // and CO at n-1=5. So MP=4 collides with HJ=4. We resolve by saying
  // MP wins for ≤6 handed, HJ wins for ≥7 handed.
  if (pos === 'MP' && n === 6) return seatsInOrder[3];   // hijack of MP at 6max — UTG=3, MP=4, CO=5
  return seatsInOrder[idx];
}

/**
 * Inverse: given a concrete seat index, return all positions that resolve
 * to it. Useful for diagnostic output on test failure.
 */
export function describeSeat(seatIndex: number, ctx: PositionContext): string[] {
  const all: AbstractPosition[] = [
    'BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO',
  ];
  return all.filter((p) => {
    try { return resolvePosition(p, ctx) === seatIndex; }
    catch { return false; }
  });
}
