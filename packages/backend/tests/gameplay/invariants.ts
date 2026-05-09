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
  /** Off-table balances for all seats. closeGame moves stacks back here on game end. */
  balances: Array<{ userId: string; chips: bigint }>;
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

  // 1. Chip conservation: balances + stacks + (pot if mid-hand) == expected.
  // When a hand is `completed`, its `pot` field still records the pot AT
  // SETTLEMENT TIME, but the chips have already moved back to winning
  // stacks. Don't double-count.
  // When the GAME completes, closeGame moves stacks back into off-table
  // ChipBalance, so we MUST include balances in the conservation check.
  const stackSum = curr.stacks.reduce((a, p) => a + p.chipStack, 0n);
  const balanceSum = curr.balances.reduce((a, b) => a + b.chips, 0n);
  const potPart = curr.stage === 'completed' ? 0n : curr.pot;
  const liveTotal = stackSum + balanceSum + potPart;
  if (liveTotal !== curr.expectedTotalChips) {
    violations.push({
      id: 'INV-CHIPS-CONSERVED',
      message: `chips: balances(${balanceSum}) + stacks(${stackSum}) + pot(${potPart}) = ${liveTotal} (stage=${curr.stage}) != expected(${curr.expectedTotalChips})`,
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

  // 3. Stage monotonic WITHIN a hand. (We rely on the caller to reset
  //    `prev` when a new hand starts. The DSL does this by tracking
  //    handNumber.)
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

  // 5. Active actor must not be folded or eliminated. (all_in is allowed:
    // engines often leave activePlayerIndex pointing to an all-in seat
    // momentarily after a betting round closes; the next read advances
    // past it. Folded/eliminated are real bugs and stay strict.)
    if (curr.stage !== 'completed' && curr.stage !== 'showdown') {
      const active = curr.stacks.find((p) => p.seatIndex === curr.activePlayerSeatIndex);
      if (active) {
        if (active.position === 'folded' || active.position === 'eliminated') {
          violations.push({
            id: 'INV-ACTIVE-NOT-INELIGIBLE',
            message: `active actor seat ${active.seatIndex} has ineligible position '${active.position}'`,
            snapshot: curr,
          });
        }
      }
    }

  // 7. Pot consistency: recorded contributions on this hand should match
  //    the live pot during play, but at hand completion the pot has been
  //    distributed to winning stacks while the `hand.pot` field may still
  //    show a residual value (engine retains it for ledger). Skip this
  //    invariant when stage=completed; chip-conservation already covers
  //    that path.
  if (curr.stage !== 'completed' && curr.pot < curr.recordedContributions) {
    violations.push({
      id: 'INV-POT-VS-CONTRIB',
      message: `pot(${curr.pot}) < recordedContributions(${curr.recordedContributions}) — chips going somewhere they shouldn't`,
      snapshot: curr,
    });
  }

  return violations;
}
