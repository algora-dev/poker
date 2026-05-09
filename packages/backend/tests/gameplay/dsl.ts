/**
 * runScripted — the gameplay test DSL.
 *
 * Wraps `runMatch` with:
 *   - Pre-declared scripted action lists per seat (keyed by hand & stage)
 *   - Position-label resolution (BTN/SB/BB → seat → userId)
 *   - Per-step invariants (chip conservation, stage monotonic, etc.)
 *   - Forced-deck integration (set BEFORE calling runScripted)
 *   - Final-state expectations
 *
 * Per Gerald's audit-20 verdict (Q3): scripts can use either abstract
 * positions OR seat indices. Both normalize internally to
 * { userId, seatIndex, resolvedPosition, action, amount } before
 * dispatch. Failures print all three.
 */

import { runMatch, type MatchConfig, type MatchReport } from '../sim/match';
import { scriptedStrategy, scriptKey, type StrategyAction, type Strategy } from '../sim/strategy';
import {
  resolvePosition,
  describeSeat,
  type AbstractPosition,
  type PositionContext,
} from './positions';
import {
  checkInvariants,
  type InvariantSnapshot,
  type InvariantViolation,
} from './invariants';

/** A single declared step in a scripted hand. */
export type ScriptedStep =
  | {
      /** Identify actor by abstract position. Resolved at hand-start time. */
      actor: AbstractPosition;
      action: 'fold' | 'check' | 'call' | 'all-in';
    }
  | {
      actor: AbstractPosition;
      action: 'raise';
      /** Total raise-to amount, in chips (not micro-units). */
      amount: number;
    }
  | {
      seat: number;
      action: 'fold' | 'check' | 'call' | 'all-in';
    }
  | {
      seat: number;
      action: 'raise';
      amount: number;
    };

export interface ScriptedHand {
  /**
   * Stage-keyed action list. Each stage is a flat list of steps in the
   * order they should execute. The DSL resolves actor → seatIndex at the
   * moment the stage starts (so dealer-rotation between hands is
   * automatic).
   */
  preflop?: ScriptedStep[];
  flop?: ScriptedStep[];
  turn?: ScriptedStep[];
  river?: ScriptedStep[];
}

export interface ScriptedConfig {
  /** Scenario name for failure output. */
  name: string;
  /** Number of seats (2–8). */
  players: number;
  /** Starting stack per seat, in chips. Length must equal `players`. */
  stacks: number[];
  /** Blinds in chips. Default { sb: 0.5, bb: 1 }. */
  blinds?: { sb: number; bb: number };
  /** One ScriptedHand per hand to play. */
  hands: ScriptedHand[];
  /** Optional: seed used by the underlying engine (passed through). */
  seed?: number;
  /** Final-state assertions (run after the last hand). */
  expect?: {
    /** Final ChipBalance.chips per seat (in chips, not micro-units). */
    finalBalances?: number[];
    /** Final GamePlayer.chipStack per seat (in chips). */
    finalStacks?: number[];
    /** Number of hands that should have completed. */
    handsCompleted?: number;
  };
}

const CHIP = 1_000_000n;
const toMicro = (n: number) => BigInt(Math.floor(n * 1_000_000));
const fromMicro = (n: bigint) => Number(n) / 1_000_000;

export interface ScriptedResult {
  ok: boolean;
  report: MatchReport;
  invariantViolations: InvariantViolation[];
  /** Full normalized step log for diagnostic output. */
  normalizedSteps: Array<{
    handIdx: number;
    stage: string;
    seat: number;
    userId: string;
    resolvedPosition: AbstractPosition | 'seat';
    action: string;
    amount?: number;
  }>;
  failureSummary?: string;
}

/**
 * Drive a scripted match. Returns a ScriptedResult; never throws (the
 * caller asserts on the result so vitest can surface the diagnostic
 * output).
 */
export async function runScripted(cfg: ScriptedConfig): Promise<ScriptedResult> {
  if (cfg.players < 2 || cfg.players > 8) {
    throw new Error(`runScripted: players must be 2-8, got ${cfg.players}`);
  }
  if (cfg.stacks.length !== cfg.players) {
    throw new Error(`runScripted: stacks length (${cfg.stacks.length}) != players (${cfg.players})`);
  }
  const blinds = cfg.blinds ?? { sb: 0.5, bb: 1 };

  const seats = Array.from({ length: cfg.players }, (_, i) => ({
    userId: `script_p${i}_${cfg.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64),
    username: `script_p${i}`,
    buyInChips: cfg.stacks[i],
    // Strategy is set per-seat below after we build the script lookup.
    strategy: (() => { throw new Error('strategy placeholder'); }) as Strategy,
  }));

  // Build a per-seat scriptedStrategy. Each seat's strategy holds a
  // pre-resolved (handNumber, stage) → ordered StrategyAction[] map.
  // Resolution from abstract position → seat happens at hand-start
  // time, in `resolveHandSteps`.
  const perSeatScripts: Record<string, Record<string, StrategyAction[]>> = {};
  for (const s of seats) perSeatScripts[s.userId] = {};

  // Snapshot tracking. We reset prev across hand boundaries because the
  // stage-monotonic invariant only makes sense within a single hand.
  const violations: InvariantViolation[] = [];
  const normalizedSteps: ScriptedResult['normalizedSteps'] = [];
  let prevSnapshot: InvariantSnapshot | null = null;
  let prevHandNumber: number | null = null;

  // Per-seat strategy: just consumes the pre-resolved script for that
  // (handNumber, stage). Position resolution is done up-front below.
  const strategiesBySeat: Strategy[] = seats.map((seat) => {
    return (view) => {
      const myScript = perSeatScripts[seat.userId][`${view.handNumber}:${view.stage}`] ?? [];
      const next = myScript.shift();
      if (!next) {
        // No action declared for this seat at this stage. Default to a
        // safe legal action: check if we can, otherwise fold. This lets
        // tests omit fold-fold-fold sequences for non-active seats.
        const owed = view.currentBet - view.alreadyInOnStreet;
        if (owed === 0n) return { kind: 'check' };
        return { kind: 'fold' };
      }
      return next;
    };
  });

  // Wire strategies into the seat configs.
  for (let i = 0; i < seats.length; i++) {
    seats[i].strategy = strategiesBySeat[i];
  }

  // Pre-walk every hand in cfg.hands. For each hand we need to know the
  // dealer + live seats AT THAT TIME. The simulator rotates the dealer
  // between hands; for hand 1 the dealer is seat 0 by convention (the
  // creator). For subsequent hands we'll resolve at hand-start time using
  // the world state.
  //
  // To keep things simple and deterministic without a complex hook, we
  // require the test to compute resolved seats up front via the
  // PositionContext API exposed below. Callers can also pass `{ seat: N }`
  // directly to bypass position resolution entirely, which is what the
  // generator (Layer C) will use.

  // For Layer A's first cut we resolve assuming the standard rotation:
  //   - Hand 1: dealer = seat 0
  //   - Hand H: dealer = seat ((H-1) mod players)
  // This matches the simulator's behavior when no eliminations occur. If
  // a test scenario triggers eliminations, the user must declare seats
  // explicitly (via { seat: N }) for affected hands.
  for (let handIdx = 0; handIdx < cfg.hands.length; handIdx++) {
    const handNumber = handIdx + 1;
    const dealerSeat = handIdx % cfg.players;
    const liveSeats = Array.from({ length: cfg.players }, (_, i) => i);
    const ctx: PositionContext = {
      dealerSeatIndex: dealerSeat,
      liveSeatIndices: liveSeats,
      totalSeats: cfg.players,
    };
    const stages: Array<keyof ScriptedHand> = ['preflop', 'flop', 'turn', 'river'];
    for (const stage of stages) {
      const steps = cfg.hands[handIdx][stage];
      if (!steps) continue;
      for (const step of steps) {
        const seat = 'seat' in step ? step.seat : resolvePosition(step.actor, ctx);
        if (seat < 0) {
          throw new Error(
            `runScripted[${cfg.name}] hand ${handNumber} ${stage}: position '${('actor' in step) ? step.actor : '?'}' has no seat at this player count`
          );
        }
        const userId = seats[seat].userId;
        const action: StrategyAction =
          step.action === 'raise'
            ? { kind: 'raise', totalChips: step.amount }
            : step.action === 'check'
              ? { kind: 'check' }
              : step.action === 'call'
                ? { kind: 'call' }
                : step.action === 'fold'
                  ? { kind: 'fold' }
                  : { kind: 'all-in' };
        const k = `${handNumber}:${stage}`;
        if (!perSeatScripts[userId][k]) perSeatScripts[userId][k] = [];
        perSeatScripts[userId][k].push(action);
        normalizedSteps.push({
          handIdx,
          stage,
          seat,
          userId,
          resolvedPosition: 'actor' in step ? step.actor : 'seat',
          action: step.action,
          amount: 'amount' in step ? step.amount : undefined,
        });
      }
    }
  }

  // Compute the expected total chip mass once. For a single match with no
  // mid-match deposits, this is the sum of buy-ins.
  const expectedTotalChips = cfg.stacks.reduce((a, n) => a + toMicro(n), 0n);

  const matchCfg: MatchConfig = {
    seats,
    smallBlindChips: blinds.sb,
    bigBlindChips: blinds.bb,
    maxHands: cfg.hands.length,
    scenarioName: cfg.name,
    seed: cfg.seed,
    strict: true,
    onAfterAction: async (ctx) => {
      // Build snapshot from current world state.
      const w = (globalThis as any).__t3PokerSimWorld;
      const hand = await w.hand.findUnique({ where: { id: ctx.handId } });
      const players = await w.gamePlayer.findMany({ where: { gameId: ctx.gameId } });

      // Sum all HandAction.amounts on this hand for the contribution check.
      const actions = await w.handAction.findMany({ where: { handId: ctx.handId } });
      const recordedContributions = actions.reduce(
        (sum: bigint, a: any) => sum + (a.amount ? BigInt(a.amount) : 0n),
        0n
      );

      // Off-table balances for all seats (chip-conservation must include
      // these once the game ends and closeGame refunds stacks back).
      // World stub doesn't support chipBalance.findMany, so query one by one.
      const balanceRows: Array<{ userId: string; chips: bigint }> = [];
      for (const s of seats) {
        const b = await w.chipBalance.findUnique({ where: { userId: s.userId } });
        if (b) balanceRows.push(b);
      }

      const snapshot: InvariantSnapshot = {
        stage: hand?.stage ?? 'unknown',
        pot: BigInt(hand?.pot ?? 0n),
        stacks: players.map((p: any) => ({
          seatIndex: p.seatIndex,
          userId: p.userId,
          chipStack: BigInt(p.chipStack),
          position: p.position,
        })),
        balances: balanceRows.map((b: any) => ({
          userId: b.userId,
          chips: BigInt(b.chips),
        })),
        activePlayerSeatIndex: hand?.activePlayerIndex ?? -1,
        recordedContributions,
        expectedTotalChips,
      };
      // Reset prev across hand boundaries (the engine increments handNumber
      // when initializeHand() runs for the next hand; if we kept prev from
      // hand N-1 the stage-monotonic check would fire on hand N's preflop).
      const handNumberNow = hand?.handNumber ?? prevHandNumber ?? 1;
      const prevForCheck = handNumberNow !== prevHandNumber ? null : prevSnapshot;
      prevHandNumber = handNumberNow;
      const found = checkInvariants(prevForCheck, snapshot);
      if (found.length) {
        violations.push(...found);
        // Throw to stop the match — runMatch's onAfterAction wrapper turns
        // this into a SimFailure with full diagnostic context.
        const detail = found.map((v) => `[${v.id}] ${v.message}`).join(' | ');
        throw new Error(
          `INVARIANT(s) FAILED at action #${ctx.actionIndex} (hand ${hand?.handNumber}, ${ctx.stage}, seat ${ctx.actorSeatIndex}, ${ctx.action}): ${detail}`
        );
      }
      prevSnapshot = snapshot;
    },
  };

  const report = await runMatch(matchCfg);

  // Final expectations.
  let failureSummary: string | undefined;
  if (cfg.expect) {
    const errs: string[] = [];
    if (cfg.expect.handsCompleted != null && report.handsPlayed !== cfg.expect.handsCompleted) {
      errs.push(`expected ${cfg.expect.handsCompleted} hands, got ${report.handsPlayed}`);
    }
    if (cfg.expect.finalBalances) {
      for (let i = 0; i < seats.length; i++) {
        const want = toMicro(cfg.expect.finalBalances[i]);
        const got = report.finalBalances.find((b) => b.userId === seats[i].userId)?.chips ?? 0n;
        if (want !== got) {
          errs.push(`seat ${i} balance: want ${cfg.expect.finalBalances[i]} chips, got ${fromMicro(got)} chips`);
        }
      }
    }
    if (cfg.expect.finalStacks) {
      for (let i = 0; i < seats.length; i++) {
        const want = toMicro(cfg.expect.finalStacks[i]);
        const got = report.finalStacks.find((s) => s.userId === seats[i].userId)?.chipStack ?? 0n;
        if (want !== got) {
          errs.push(`seat ${i} stack: want ${cfg.expect.finalStacks[i]} chips, got ${fromMicro(got)} chips`);
        }
      }
    }
    if (errs.length) failureSummary = errs.join('; ');
  }

  const ok =
    report.endedReason !== 'error' &&
    report.conservationOk &&
    violations.length === 0 &&
    !failureSummary;

  return {
    ok,
    report,
    invariantViolations: violations,
    normalizedSteps,
    failureSummary,
  };
}
