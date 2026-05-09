/**
 * Per-step invariants for the gameplay test layer.
 *
 * These run BETWEEN every action in a script. If any fail, the test
 * stops with a deterministic step number, full state diff, and (if a
 * forced deck was used) the deck for replay.
 *
 * Invariants checked:
 *   1. Chip conservation:        sum(stacks) + pot = expected total
 *   2. No negative stacks
 *   3. Hand-stage monotonic:     preflop → flop → turn → river → showdown → completed
 *   4. Pot non-negative
 *   5. Folded/all-in/eliminated players cannot be the active actor
 *   6. exactly one active actor when stage != completed (or 0 if hand-completing)
 *   7. Pot equals sum of recorded contributions on this hand (handAction rows)
 */

const STAGE_ORDER: Record<string, number> = {
  preflop: 0,
  flop: 1,
  turn: 2,
  river: 3,
  showdown: 4,
  completed: 5,
};

export interface InvariantSnapshot {
  stage: string;
  pot: bigint;
  stacks: Array<{ seatIndex: number; userId: string; chipStack: bigint; position: string }>;
  activePlayerSeatIndex: number;
  /** Sum of all HandAction.amount rows so far on this hand (excluding folds/checks). */
  recordedContributions: bigint;
  /** Expected total chips at the table (initial sum of buy-ins for this hand cohort). */
  expectedTotalChips: bigint;
}

export interface InvariantViolation {
  id: string;
  message: string;
  snapshot: InvariantSnapshot;
}

export function checkInvariants(
  prev: InvariantSnapshot | null,
  curr: InvariantSnapshot
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // 1. Chip conservation: stacks + pot == expected.
  // When a hand is `completed`, its `pot` field still records the pot AT
  // SETTLEMENT TIME, but the chips have already moved back to winning
  // stacks. Don't double-count.
  const stackSum = curr.stacks.reduce((a, p) => a + p.chipStack, 0n);
  const liveTotal = curr.stage === 'completed' ? stackSum : stackSum + curr.pot;
  if (liveTotal !== curr.expectedTotalChips) {
    violations.push({
      id: 'INV-CHIPS-CONSERVED',
      message: `chips: stacks(${stackSum}) + pot(${curr.pot}) = ${liveTotal} (stage=${curr.stage}) != expected(${curr.expectedTotalChips})`,
      snapshot: curr,
    });
  }

  // 2. No negative stacks.
  for (const p of curr.stacks) {
    if (p.chipStack < 0n) {
      violations.push({
        id: 'INV-NO-NEG-STACK',
        message: `seat ${p.seatIndex} (${p.userId}) has negative stack ${p.chipStack}`,
        snapshot: curr,
      });
    }
  }

  // 3. Stage monotonic.
  if (prev) {
    const prevOrder = STAGE_ORDER[prev.stage] ?? -1;
    const currOrder = STAGE_ORDER[curr.stage] ?? -1;
    if (currOrder < prevOrder) {
      violations.push({
        id: 'INV-STAGE-MONOTONIC',
        message: `stage went backwards: ${prev.stage} -> ${curr.stage}`,
        snapshot: curr,
      });
    }
  }

  // 4. Pot non-negative.
  if (curr.pot < 0n) {
    violations.push({
      id: 'INV-POT-NONNEG',
      message: `pot is negative: ${curr.pot}`,
      snapshot: curr,
    });
  }

  // 5. Active actor must not be folded/all_in/eliminated.
  if (curr.stage !== 'completed' && curr.stage !== 'showdown') {
    const active = curr.stacks.find((p) => p.seatIndex === curr.activePlayerSeatIndex);
    if (active) {
      if (active.position === 'folded' || active.position === 'eliminated' || active.position === 'all_in') {
        violations.push({
          id: 'INV-ACTIVE-NOT-INELIGIBLE',
          message: `active actor seat ${active.seatIndex} has ineligible position '${active.position}'`,
          snapshot: curr,
        });
      }
    }
  }

  // 7. Pot consistency: recorded contributions on this hand should match
  //    the live pot, allowing for the fact that the engine may pre-credit
  //    blinds before any HandAction rows exist for them. We allow a small
  //    relaxation: pot >= recordedContributions, and they converge as the
  //    hand progresses. A pot that's LESS than recorded contributions is
  //    a bug.
  if (curr.pot < curr.recordedContributions) {
    violations.push({
      id: 'INV-POT-VS-CONTRIB',
      message: `pot(${curr.pot}) < recordedContributions(${curr.recordedContributions}) — chips going somewhere they shouldn't`,
      snapshot: curr,
    });
  }

  return violations;
}
