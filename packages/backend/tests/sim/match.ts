/**
 * tests/sim/match.ts
 *
 * Match orchestrator. Given a config (seats, strategies, blinds, hand limit,
 * seed) it:
 *   1. Seeds users + chip balances + a Game row in the simulator world.
 *   2. Calls atomicStartGame to flip status + init the first hand.
 *   3. Loops: read currentHand, ask the active seat's strategy, call
 *      processAction, repeat until hand completes; init next hand; stop
 *      when a hand limit hits or the game completes.
 *   4. After each hand, checks chip-conservation invariants.
 *
 * Returns a structured run report including a per-hand summary and the full
 * HandEvent ledger so tests can assert any property.
 */

import { buildSimWorld } from './world';
import { Strategy, PlayerView, StrategyAction } from './strategy';

export interface MatchConfig {
  /** 2-8 seats. */
  seats: Array<{
    userId: string;
    username?: string;
    buyInChips: number; // chips at 6 decimals (e.g. 100 = 100_000_000n)
    strategy: Strategy;
  }>;
  smallBlindChips?: number; // default 0.5
  bigBlindChips?: number; // default 1.0
  maxHands: number;
  /**
   * Maximum total actions (defense against an infinite loop in a buggy
   * strategy). Default 2000 — easily covers 50+ hands of normal play.
   */
  maxActions?: number;
  gameName?: string;
  /** Optional seed (passed through to the report for repro). */
  seed?: number;
  /** Friendly name for failure reporting. Optional. */
  scenarioName?: string;
  /**
   * Phase 9 follow-up [item 5]: in strict mode, an illegal strategy action
   * is a HARD failure (errored MatchReport). In non-strict (default for
   * fuzzing), illegal actions silently fall back to check/fold so the
   * match can continue.
   */
  strict?: boolean;
}

/**
 * Phase 9 follow-up [item 5]: rich failure metadata so any sim failure can
 * be reproduced from the report alone.
 */
export interface SimFailure {
  scenarioName?: string;
  seed?: number;
  handNumber: number;
  activeUserId?: string;
  activeSeat?: number;
  attemptedAction?: string;
  attemptedRaiseTotal?: number;
  reason: string;
  underlyingError?: string;
}

export interface HandSummary {
  handNumber: number;
  startStage: string;
  endReason: 'fold_win' | 'showdown' | 'unknown';
  potTotal: bigint;
  winners: string[];
  finalStacks: Array<{ userId: string; chipStack: bigint }>;
  actions: Array<{
    userId: string;
    action: string;
    amount: bigint | null;
    stage: string;
  }>;
}

export interface MatchReport {
  scenarioName?: string;
  seed?: number;
  handsPlayed: number;
  finalBalances: Array<{ userId: string; chips: bigint }>;
  finalStacks: Array<{ userId: string; chipStack: bigint }>;
  hands: HandSummary[];
  ledgerEvents: Array<{
    handId: string | null;
    sequence: number;
    type: string;
    userId: string | null;
    payload: any;
  }>;
  /** True if chip conservation held across every hand. */
  conservationOk: boolean;
  /** First conservation violation, if any. */
  conservationFailure?: {
    handNumber: number;
    expected: bigint;
    actual: bigint;
  };
  endedReason: 'maxHands' | 'gameOver' | 'maxActions' | 'error';
  error?: string;
  /** Phase 9 follow-up [item 5]: structured failure for repro. */
  failure?: SimFailure;
}

const CHIP_UNIT = 1_000_000n;

function toMicro(chips: number): bigint {
  return BigInt(Math.floor(chips * 1_000_000));
}

export async function runMatch(cfg: MatchConfig): Promise<MatchReport> {
  if (cfg.seats.length < 2 || cfg.seats.length > 8) {
    throw new Error('seats must be 2-8');
  }
  __activeCfg = cfg;
  const sb = toMicro(cfg.smallBlindChips ?? 0.5);
  const bb = toMicro(cfg.bigBlindChips ?? 1.0);
  const maxActions = cfg.maxActions ?? 2000;

  // 1) Set up world with users + balances. createGame and joinGame will
  //    deduct each player's buyIn from their off-table balance, so we seed
  //    each balance with exactly buyIn chips. After buy-in the balance is 0
  //    and the stack holds buyIn chips. Total chip mass is sum(buyIns).
  const world = buildSimWorld();
  for (const s of cfg.seats) {
    await world.client.user.create({
      data: { id: s.userId, username: s.username ?? s.userId },
    });
    await world.client.chipBalance.upsert({
      where: { userId: s.userId },
      create: { userId: s.userId, chips: toMicro(s.buyInChips) },
      update: { chips: { increment: 0n } },
    });
  }

  // Wire the simulated prisma into the real game module via vi.mock done
  // at the test-file level. Tests must call worldGlobal() before importing
  // the modules under test.
  (globalThis as any).__t3PokerSimWorld = world.client;

  const { createGame, joinGame } = await import('../../src/services/game');
  const { atomicStartGame, initializeHand } = await import('../../src/services/holdemGame');
  const { processAction } = await import('../../src/services/pokerActions');

  // 2) Create game owned by seat 0, then seats 1..N join.
  // Use the min/max buy-in across all seats so heterogeneous-stack scenarios
  // can validate joinGame's buy-in range.
  const buyIns = cfg.seats.map((s) => toMicro(s.buyInChips));
  const minBuyIn = buyIns.reduce((m, v) => (v < m ? v : m), buyIns[0]);
  const maxBuyIn = buyIns.reduce((m, v) => (v > m ? v : m), buyIns[0]);
  const created = await createGame(
    cfg.seats[0].userId,
    cfg.gameName ?? 'sim',
    minBuyIn,
    maxBuyIn,
    sb,
    bb,
    toMicro(cfg.seats[0].buyInChips),
    { maxPlayers: cfg.seats.length, autoStart: false }
  );
  const gameId: string = (created as any).game.id;
  for (let i = 1; i < cfg.seats.length; i++) {
    await joinGame(cfg.seats[i].userId, gameId, toMicro(cfg.seats[i].buyInChips));
  }

  // Capture expected chip mass BEFORE the first hand starts (atomicStartGame
  // deals blinds, which moves chips from stacks into the pot; once a hand is
  // in flight, balances+stacks no longer captures the full mass). At this
  // point: balances=0, stacks=sum(buyIns), pot=0. Total is stable.
  const totalChips = sumTotal(world);

  // 3) Atomic start.
  const start = await atomicStartGame(gameId, world.client);
  if (start.ok !== true) {
    return finalReport(world, [], 'error', `start failed: ${start.message}`);
  }

  const hands: HandSummary[] = [];
  let actionsTaken = 0;
  let endedReason: MatchReport['endedReason'] = 'maxHands';
  let conservationFailure: MatchReport['conservationFailure'];

  // 4) Hand loop.
  for (let h = 1; h <= cfg.maxHands; h++) {
    const hand = await getCurrentHand(world, gameId);
    if (!hand) {
      endedReason = 'gameOver';
      break;
    }
    const handId = hand.id;
    const summary: HandSummary = {
      handNumber: hand.handNumber,
      startStage: hand.stage,
      endReason: 'unknown',
      potTotal: 0n,
      winners: [],
      finalStacks: [],
      actions: [],
    };

    // Drive actions until the hand completes (stage='completed').
    // Each iteration: read state, ask strategy, call processAction.
    let safety = 0;
    while (++safety < 300) {
      if (++actionsTaken > maxActions) {
        endedReason = 'maxActions';
        return finalReport(world, hands, endedReason);
      }
      const fresh = await world.client.hand.findUnique({ where: { id: handId } });
      if (!fresh || fresh.stage === 'completed') break;

      const game = await world.client.game.findUnique({
        where: { id: gameId },
        include: { players: true },
      });
      if (!game) break;
      const players = game.players as any[];
      const activeSeat = fresh.activePlayerIndex;
      const activePlayer = players.find((p: any) => p.seatIndex === activeSeat);
      if (!activePlayer) break;

      const seat = cfg.seats.find((s) => s.userId === activePlayer.userId);
      if (!seat) break;

      const view: PlayerView = {
        seatIndex: activeSeat,
        userId: activePlayer.userId,
        handNumber: hand.handNumber,
        stage: fresh.stage as any,
        currentBet: BigInt(fresh.currentBet),
        bigBlind: BigInt(game.bigBlind),
        alreadyInOnStreet: await sumStreetContribution(world, handId, activePlayer.userId, fresh.stage),
        chipStack: BigInt(activePlayer.chipStack),
        pot: BigInt(fresh.pot),
        livePlayers: players.filter((p: any) => p.position !== 'folded' && p.position !== 'eliminated').length,
      };

      const decision = seat.strategy(view);
      const { actionName, raiseTotal } = mapDecision(decision, view);

      try {
        await processAction(gameId, activePlayer.userId, actionName as any, raiseTotal);
        summary.actions.push({
          userId: activePlayer.userId,
          action: actionName,
          amount: null,
          stage: fresh.stage,
        });
      } catch (err: any) {
        // Phase 9 follow-up [item 5]: in strict mode, fail hard with full
        // metadata so the scenario can be reproduced. Otherwise fall back
        // to check/fold so fuzz runs can continue.
        const failure: SimFailure = {
          scenarioName: cfg.scenarioName,
          seed: cfg.seed,
          handNumber: hand.handNumber,
          activeUserId: activePlayer.userId,
          activeSeat,
          attemptedAction: actionName,
          attemptedRaiseTotal: raiseTotal,
          reason: 'illegal_action',
          underlyingError: String(err?.message ?? err),
        };
        if (cfg.strict) {
          endedReason = 'error';
          return finalReportWithFailure(world, hands, endedReason, failure);
        }
        const fallback = view.currentBet > view.alreadyInOnStreet ? 'fold' : 'check';
        try {
          await processAction(gameId, activePlayer.userId, fallback as any);
          summary.actions.push({
            userId: activePlayer.userId,
            action: fallback,
            amount: null,
            stage: fresh.stage,
          });
        } catch (innerErr: any) {
          endedReason = 'error';
          return finalReportWithFailure(world, hands, endedReason, {
            ...failure,
            reason: 'illegal_action_and_fallback_failed',
            underlyingError: `${failure.underlyingError}; fallback: ${String(innerErr?.message ?? innerErr)}`,
          });
        }
      }
    }

    // Hand ended. Capture summary.
    const finishedHand = await world.client.hand.findUnique({ where: { id: handId } });
    if (finishedHand) {
      summary.potTotal = BigInt(finishedHand.pot);
      summary.winners = JSON.parse(finishedHand.winnerIds || '[]');
    }
    summary.endReason = inferHandReason(world, gameId, handId);
    const stacksNow = (await world.client.gamePlayer.findMany({ where: { gameId } })) as any[];
    summary.finalStacks = stacksNow.map((p) => ({ userId: p.userId, chipStack: BigInt(p.chipStack) }));
    hands.push(summary);

    // Conservation check.
    const total = sumTotal(world);
    if (total !== totalChips) {
      conservationFailure = { handNumber: hand.handNumber, expected: totalChips, actual: total };
      endedReason = 'error';
      break;
    }

    // Game ended?
    const fresh2 = await world.client.game.findUnique({ where: { id: gameId } });
    if (fresh2?.status === 'completed') {
      endedReason = 'gameOver';
      break;
    }

    // In production, the API's post-hand setTimeout countdown invokes
    // initializeHand for the next hand. The simulator runs synchronously
    // and has no setTimeout, so we call it directly here. checkGameContinuation
    // has already rotated the dealer and reset player positions, so this is
    // safe to call.
    const stillNeeded = h < cfg.maxHands;
    if (stillNeeded) {
      const noActiveHand =
        (await world.client.hand.findFirst({
          where: { gameId, stage: { not: 'completed' } },
          orderBy: { createdAt: 'desc' },
        })) == null;
      if (noActiveHand) {
        try {
          await initializeHand(gameId);
        } catch (err: any) {
          // E.g. only one active player left -> game has effectively ended
          // even though status was not flipped to 'completed'. Treat as game
          // over.
          endedReason = 'gameOver';
          break;
        }
      }
    }
  }

  return finalReport(world, hands, endedReason, undefined, conservationFailure);
}

// Module-scope reference to the active config so finalReport can attach
// scenarioName/seed without threading them through every call site.
let __activeCfg: MatchConfig | null = null;

function finalReport(
  world: ReturnType<typeof buildSimWorld>,
  hands: HandSummary[],
  endedReason: MatchReport['endedReason'],
  error?: string,
  conservationFailure?: MatchReport['conservationFailure']
): MatchReport {
  const s = world.state();
  return {
    scenarioName: __activeCfg?.scenarioName,
    seed: __activeCfg?.seed,
    handsPlayed: hands.length,
    finalBalances: s.balances.map((b) => ({ userId: b.userId, chips: b.chips })),
    finalStacks: s.gamePlayers.map((p) => ({ userId: p.userId, chipStack: p.chipStack })),
    hands,
    ledgerEvents: s.handEvents
      .slice()
      .sort((a, b) => a.serverTime.getTime() - b.serverTime.getTime())
      .map((e) => ({
        handId: e.handId,
        sequence: e.sequenceNumber,
        type: e.eventType,
        userId: e.userId,
        payload: safeJsonParse(e.payload),
      })),
    conservationOk: !conservationFailure,
    conservationFailure,
    endedReason,
    error,
  };
}

function finalReportWithFailure(
  world: ReturnType<typeof buildSimWorld>,
  hands: HandSummary[],
  endedReason: MatchReport['endedReason'],
  failure: SimFailure
): MatchReport {
  const r = finalReport(world, hands, endedReason, failure.underlyingError);
  return { ...r, failure };
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function getCurrentHand(
  world: ReturnType<typeof buildSimWorld>,
  gameId: string
): Promise<any | null> {
  const list = (await world.client.hand.findFirst({
    where: { gameId, stage: { not: 'completed' } },
    orderBy: { createdAt: 'desc' },
  })) as any;
  return list ?? null;
}

async function sumStreetContribution(
  world: ReturnType<typeof buildSimWorld>,
  handId: string,
  userId: string,
  stage: string
): Promise<bigint> {
  const agg = await world.client.handAction.aggregate({
    where: { handId, userId, stage },
    _sum: { amount: true },
  });
  return BigInt(agg._sum.amount ?? 0n);
}

function sumTotal(world: ReturnType<typeof buildSimWorld>): bigint {
  const s = world.state();
  const balances = s.balances.reduce((sum, b) => sum + b.chips, 0n);
  const stacks = s.gamePlayers.reduce((sum, p) => sum + p.chipStack, 0n);
  return balances + stacks;
}

function inferHandReason(
  world: ReturnType<typeof buildSimWorld>,
  _gameId: string,
  handId: string
): HandSummary['endReason'] {
  const s = world.state();
  const events = s.handEvents.filter((e) => e.handId === handId);
  if (events.some((e) => e.eventType === 'showdown_evaluated')) return 'showdown';
  if (events.some((e) => e.eventType === 'pot_awarded')) {
    const award = events.find((e) => e.eventType === 'pot_awarded');
    try {
      const p = JSON.parse(award!.payload);
      if (p.reason === 'fold_win') return 'fold_win';
    } catch { /* */ }
  }
  return 'unknown';
}

function mapDecision(d: StrategyAction, _view: PlayerView): { actionName: string; raiseTotal?: number } {
  switch (d.kind) {
    case 'check':
      return { actionName: 'check' };
    case 'call':
      return { actionName: 'call' };
    case 'fold':
      return { actionName: 'fold' };
    case 'all-in':
      return { actionName: 'all-in' };
    case 'raise':
      return { actionName: 'raise', raiseTotal: d.totalChips };
  }
}
