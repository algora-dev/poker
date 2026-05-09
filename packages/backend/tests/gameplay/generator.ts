/**
 * Layer C — combinatorial generator.
 *
 * Produces legal-action templates over a curated cross-product of:
 *   - Player counts: 2, 3, 4, 5, 6, 8
 *   - Stack profiles: equal-deep, equal-short, one-short, one-deep,
 *     two-shorts, asymmetric
 *   - Action templates: fold-around, all-call-see-river, raise-fold-pre,
 *     raise-call-see-flop, all-in-confrontation, multi-way-all-in
 *
 * Each generated scenario uses the engine's RNG (no forced deck) — the
 * point is INVARIANT compliance, not a specific chip outcome. Every
 * scenario must:
 *   - complete without engine error
 *   - preserve chip conservation across the whole match
 *   - never trigger a hard invariant violation
 *
 * Per Gerald (audit-20): we don't claim "every legal sequence" — that's
 * combinatorially huge. We claim "systematic high-risk coverage of legal
 * templates with strict invariants on every step."
 */

import { runScripted, type ScriptedConfig, type ScriptedHand, type ScriptedStep } from './dsl';

export type StackProfile =
  | 'equal-deep'
  | 'equal-short'
  | 'one-short'
  | 'one-deep'
  | 'two-shorts'
  | 'asymmetric';

export type ActionTemplate =
  | 'fold-around'
  | 'all-call-see-river'
  | 'raise-fold-pre'
  | 'raise-call-see-flop'
  | 'multi-way-all-in';

export interface GeneratedScenario {
  cfg: ScriptedConfig;
  /** Human-readable description for failure messages. */
  label: string;
}

/** Build a stacks array per profile. */
function buildStacks(players: number, profile: StackProfile): number[] {
  switch (profile) {
    case 'equal-deep':
      return Array.from({ length: players }, () => 200);
    case 'equal-short':
      return Array.from({ length: players }, () => 30);
    case 'one-short':
      return Array.from({ length: players }, (_, i) => (i === 0 ? 30 : 200));
    case 'one-deep':
      return Array.from({ length: players }, (_, i) => (i === 0 ? 500 : 100));
    case 'two-shorts':
      return Array.from({ length: players }, (_, i) => (i < 2 ? 30 : 200));
    case 'asymmetric':
      return Array.from({ length: players }, (_, i) => 50 + i * 30);
  }
}

/**
 * For a given player count, return seat indices in preflop order.
 * Heads-up: SB acts first preflop (seat 0 in our layout for hand 1).
 * 3+ handed: UTG (next after BB) acts first.
 */
function preflopOrder(players: number, dealerSeat = 0): number[] {
  const seats: number[] = [];
  if (players === 2) {
    // SB (== dealer) acts first preflop, then BB.
    seats.push(dealerSeat % players);
    seats.push((dealerSeat + 1) % players);
    return seats;
  }
  // 3+: SB = dealer+1, BB = dealer+2, UTG = dealer+3 (mod players).
  // Preflop order: UTG, then UTG+1, ..., wrapping around to BB.
  for (let i = 3; i < 3 + players; i++) {
    seats.push((dealerSeat + i) % players);
  }
  return seats;
}

/**
 * Postflop order (3+ handed): SB first, then BB, ..., then BTN.
 * Heads-up: BB first, then SB.
 */
function postflopOrder(players: number, dealerSeat = 0): number[] {
  const seats: number[] = [];
  if (players === 2) {
    seats.push((dealerSeat + 1) % players); // BB
    seats.push(dealerSeat % players);       // SB / BTN
    return seats;
  }
  for (let i = 1; i <= players; i++) {
    seats.push((dealerSeat + i) % players);
  }
  return seats;
}

/** Build one scripted hand for a given action template. */
function buildHand(players: number, template: ActionTemplate, stacks: number[]): ScriptedHand {
  const pf = preflopOrder(players);
  const pof = postflopOrder(players);

  switch (template) {
    case 'fold-around': {
      // Everyone except BB folds preflop. Walk.
      const preflop: ScriptedStep[] = [];
      for (const seat of pf.slice(0, pf.length - 1)) {
        preflop.push({ seat, action: 'fold' });
      }
      return { preflop };
    }
    case 'all-call-see-river': {
      // Everyone calls preflop, then BB exercises option (check). Same rule
      // for heads-up (last preflop actor is BB) and 3+ (last is BB).
      const preflop: ScriptedStep[] = [];
      for (let i = 0; i < pf.length; i++) {
        const seat = pf[i];
        if (i === pf.length - 1) {
          // Last to act preflop is always BB → check the option.
          preflop.push({ seat, action: 'check' });
        } else {
          preflop.push({ seat, action: 'call' });
        }
      }
      const checks = (order: number[]): ScriptedStep[] =>
        order.map((seat) => ({ seat, action: 'check' as const }));
      return {
        preflop,
        flop: checks(pof),
        turn: checks(pof),
        river: checks(pof),
      };
    }
    case 'raise-fold-pre': {
      // First to act raises 3 BB; everyone else folds.
      const preflop: ScriptedStep[] = [{ seat: pf[0], action: 'raise', amount: 3 }];
      for (let i = 1; i < pf.length; i++) {
        preflop.push({ seat: pf[i], action: 'fold' });
      }
      return { preflop };
    }
    case 'raise-call-see-flop': {
      // First to act raises 3, second calls, others fold. See flop, all check down.
      const preflop: ScriptedStep[] = [{ seat: pf[0], action: 'raise', amount: 3 }];
      for (let i = 1; i < pf.length; i++) {
        preflop.push({ seat: pf[i], action: i === 1 ? 'call' : 'fold' });
      }
      // Postflop: only seats pf[0] and pf[1] remain. They check down in
      // postflop order (whichever of them is earlier postflop acts first).
      const remaining = new Set([pf[0], pf[1]]);
      const orderedPF = pof.filter((s) => remaining.has(s));
      const checks = (order: number[]): ScriptedStep[] =>
        order.map((seat) => ({ seat, action: 'check' as const }));
      return {
        preflop,
        flop: checks(orderedPF),
        turn: checks(orderedPF),
        river: checks(orderedPF),
      };
    }
    case 'multi-way-all-in': {
      // Everyone shoves preflop. Useful only when stacks are short enough
      // to be legal shoves regardless of order.
      const preflop: ScriptedStep[] = pf.map((seat) => ({
        seat,
        action: 'all-in' as const,
      }));
      return { preflop };
    }
  }
}

export function generateScenarios(): GeneratedScenario[] {
  const playerCounts = [2, 3, 4, 5, 6, 8];
  const profiles: StackProfile[] = [
    'equal-deep',
    'equal-short',
    'one-short',
    'one-deep',
    'two-shorts',
    'asymmetric',
  ];
  const templates: ActionTemplate[] = [
    'fold-around',
    'all-call-see-river',
    'raise-fold-pre',
    'raise-call-see-flop',
    'multi-way-all-in',
  ];

  const scenarios: GeneratedScenario[] = [];
  for (const players of playerCounts) {
    for (const profile of profiles) {
      for (const template of templates) {
        // Skip combinations that can't legally execute:
        //   - multi-way-all-in with deep stacks creates pots that the
        //     test infrastructure doesn't need to enumerate (covered by
        //     hand-crafted MW-02). Restrict to short stacks.
        if (template === 'multi-way-all-in' && profile !== 'equal-short' && profile !== 'one-short' && profile !== 'two-shorts') {
          continue;
        }
        const stacks = buildStacks(players, profile);
        // multi-way-all-in needs stacks small enough; if any stack <
        // BB (1) we'd also have a problem. Skip when min stack < 2.
        if (Math.min(...stacks) < 2) continue;

        const label = `${players}p_${profile}_${template}`;
        scenarios.push({
          label,
          cfg: {
            name: label,
            players,
            stacks,
            hands: [buildHand(players, template, stacks)],
            // No expect block — generator only checks invariants + chip
            // conservation, not specific chip outcomes.
          },
        });
      }
    }
  }
  return scenarios;
}

export interface GeneratorReport {
  totalScenarios: number;
  passed: number;
  failed: number;
  failures: Array<{
    label: string;
    summary: string;
  }>;
}

export async function runGenerator(): Promise<GeneratorReport> {
  const scenarios = generateScenarios();
  const failures: GeneratorReport['failures'] = [];
  let passed = 0;
  for (const s of scenarios) {
    const r = await runScripted(s.cfg);
    if (r.ok) {
      passed++;
    } else {
      failures.push({
        label: s.label,
        summary: [
          r.failureSummary ?? 'see violations',
          ...(r.invariantViolations.length
            ? [`Invariants: ${r.invariantViolations.map((v) => `[${v.id}] ${v.message}`).join(' | ')}`]
            : []),
          ...(r.report.failure
            ? [`Failure: ${JSON.stringify(r.report.failure).slice(0, 400)}`]
            : []),
        ].join(' || '),
      });
    }
  }
  return {
    totalScenarios: scenarios.length,
    passed,
    failed: failures.length,
    failures,
  };
}
