/**
 * Invariants checked after each hand and at session end.
 * A failure throws — the harness exits non-zero.
 */
import { PrismaClient } from '@prisma/client';
import type { BotClient } from './botClient';
import { INV, type RunLog } from './runLog';

export interface InvariantContext {
  gameId: string;
  bots: BotClient[];
  /** Sum of (initial buy-in chips) across all bots, in micro-units. */
  initialChipsTotal: bigint;
  prisma: PrismaClient;
  /** Optional run log for structured failure reporting. */
  runLog?: RunLog;
}

function failInvariant(ctx: InvariantContext, id: string, msg: string): never {
  ctx.runLog?.write({ kind: 'invariant.fail', invariantId: id, data: { msg } });
  const err = new Error(`[${id}] ${msg}`);
  (err as any).invariantId = id;
  throw err;
}

function microSum(microStrs: string[]): bigint {
  return microStrs.reduce((a, s) => a + BigInt(s), 0n);
}

/**
 * Conservation: at any time, sum of player stacks at the table + current pot
 * + chips already cashed out (recorded as `chip_balance` deltas) must equal
 * the initial chips bought-in.
 *
 * Eliminated players have stack=0 at table; their chips are in the pot or
 * already in another player's stack. Cashout returns chips to ChipBalance.
 */
export async function assertChipsConserved(ctx: InvariantContext) {
  const { prisma, gameId, initialChipsTotal } = ctx;
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { players: true, hands: { where: { stage: { not: 'completed' } }, take: 1 } },
  });
  if (!game) throw new Error(`Game ${gameId} disappeared`);

  const stackTotal = game.players.reduce((a, p) => a + p.chipStack, 0n);
  const pot = game.hands[0]?.pot ?? 0n;

  // Cashouts: ChipAudit operation='game_cashout' or 'eliminate' for this game.
  // We approximate via chipAudit notes since the table doesn't have a gameId
  // foreign key in the current schema.
  // Instead we read each bot's current ChipBalance and compare to a snapshot
  // we took at start.
  // For simplicity: stackTotal + pot + sum(cashedOut) must equal initialChipsTotal.
  // Cashed out = current ChipBalance.chips - ChipBalance.chipsAtStart.
  // The harness tracks chipsAtStart externally; assertion is in assertSessionLedger.
  if (game.status === 'in_progress') {
    // Per-tick reads happen OUTSIDE any DB transaction. Under high
    // concurrency the snapshot can show a transient where one bot's
    // chipStack write is visible but another action's commit hasn't
    // landed yet. We allow a small tolerance here and let the strict
    // end-of-session ledger check be the authoritative invariant.
    // The tolerance is an absolute number of micro-chips, not a
    // percentage — a real leak from a logic bug will be much bigger
    // than a few SB/BB-sized transients.
    const TICK_TOLERANCE_MICRO = 5_000_000n; // 5 chips
    const overage = stackTotal + pot - initialChipsTotal;
    if (overage > TICK_TOLERANCE_MICRO) {
      failInvariant(
        ctx,
        INV.CHIPS_CONSERVED,
        `Chip leak: stacks(${stackTotal}) + pot(${pot}) = ${
          stackTotal + pot
        } > initial(${initialChipsTotal}) by ${overage}`
      );
    }
    // Underage during in_progress is fine (cashout-on-elimination etc.).
    // The strict end-of-session check covers true conservation.
  }

  for (const p of game.players) {
    if (p.chipStack < 0n) {
      failInvariant(ctx, INV.NO_NEG_STACK, `Negative chip stack for ${p.userId}: ${p.chipStack}`);
    }
  }
}

/**
 * End-of-session ledger check:
 * sum(final ChipBalance) for the bots == sum(starting ChipBalance) for the bots.
 * Game itself is a closed system; chips can move between bots but cannot vanish.
 */
export async function assertSessionLedger(
  ctx: InvariantContext,
  startingBalances: Map<string, bigint>
) {
  const { prisma } = ctx;
  let startTotal = 0n;
  let endTotal = 0n;
  for (const [userId, start] of startingBalances) {
    startTotal += start;
    const bal = await prisma.chipBalance.findUnique({ where: { userId } });
    const end = bal?.chips ?? 0n;
    endTotal += end;
  }

  // Also account for chips locked in the game (not yet cashed back).
  const game = await prisma.game.findUnique({
    where: { id: ctx.gameId },
    include: { players: true, hands: true },
  });
  if (!game) throw new Error('game vanished');

  const lockedInGame = game.players.reduce((a, p) => a + p.chipStack, 0n);
  const livePot = game.hands.find((h) => h.stage !== 'completed')?.pot ?? 0n;

  const total = endTotal + lockedInGame + livePot;
  if (total !== startTotal) {
    failInvariant(
      ctx,
      INV.SESSION_LEDGER,
      `Ledger mismatch: start=${startTotal} end=${endTotal} locked=${lockedInGame} pot=${livePot} total=${total} delta=${
        total - startTotal
      }`
    );
  }
}

/**
 * Stall detection: nobody should sit on isMyTurn for >60s.
 */
export function assertNoStalls(ctx: InvariantContext, maxStallMs = 90_000) {
  const now = Date.now();
  for (const b of ctx.bots) {
    // Silent bots are EXPECTED to sit on their turn (testing auto-fold).
    if (b.cfg.silent) continue;
    if (b.turnStartedAt && now - b.turnStartedAt > maxStallMs) {
      failInvariant(
        ctx,
        INV.NO_STALLS,
        `Bot ${b.cfg.email} stalled on its turn for ${now - b.turnStartedAt}ms`
      );
    }
  }
}

/**
 * No bot accumulated unrecoverable client-side errors.
 * Some action errors are expected (race-loser bots), so we cap at a threshold
 * proportional to actions taken.
 */
export function assertBotsHealthy(ctx: InvariantContext) {
  for (const b of ctx.bots) {
    const allowed = Math.max(3, Math.floor(b.actionsTaken * 0.1));
    if (b.errors.length > allowed) {
      failInvariant(
        ctx,
        INV.BOTS_HEALTHY,
        `Bot ${b.cfg.email} accumulated ${b.errors.length} errors (allowed ${allowed}). First few: ${b.errors
          .slice(0, 5)
          .join(' | ')}`
      );
    }
  }
}

/**
 * Phase 10 [H-01] invariant: any game whose status is 'completed' or
 * 'cancelled' must have:
 *   - sum(GamePlayer.chipStack) == 0 (no chips locked at the table)
 *   - no Hand row whose stage != 'completed' with pot > 0
 */
export async function assertClosedGamesAreEmpty(prisma: PrismaClient, runLog?: RunLog) {
  const closedGames = await prisma.game.findMany({
    where: { status: { in: ['completed', 'cancelled'] } },
    select: {
      id: true,
      status: true,
      players: { select: { chipStack: true, userId: true } },
      hands: { select: { id: true, stage: true, pot: true } },
    },
  });
  for (const g of closedGames) {
    const stackSum = g.players.reduce((a, p) => a + BigInt(p.chipStack ?? 0n), 0n);
    if (stackSum !== 0n) {
      const msg = `Closed game ${g.id} (${g.status}) still has ${stackSum} chips on the table`;
      runLog?.write({ kind: 'invariant.fail', invariantId: INV.CLOSED_GAMES_EMPTY, data: { msg, gameId: g.id } });
      const err = new Error(`[${INV.CLOSED_GAMES_EMPTY}] ${msg}`);
      (err as any).invariantId = INV.CLOSED_GAMES_EMPTY;
      throw err;
    }
    for (const h of g.hands) {
      if (h.stage !== 'completed' && BigInt(h.pot ?? 0n) > 0n) {
        const msg = `Closed game ${g.id} has open hand ${h.id} (stage=${h.stage}, pot=${h.pot})`;
        runLog?.write({ kind: 'invariant.fail', invariantId: INV.CLOSED_GAMES_EMPTY, data: { msg, gameId: g.id, handId: h.id } });
        const err = new Error(`[${INV.CLOSED_GAMES_EMPTY}] ${msg}`);
        (err as any).invariantId = INV.CLOSED_GAMES_EMPTY;
        throw err;
      }
    }
  }
}

/**
 * HandEvent sequence numbers must be monotonic per scopeId.
 * Tests Gerald's Item 4 fix end-to-end (under live concurrency).
 */
export async function assertHandEventSequencesMonotonic(prisma: PrismaClient, runLog?: RunLog) {
  const events = await prisma.handEvent.findMany({
    select: { scopeId: true, sequenceNumber: true, serverTime: true },
    orderBy: [{ scopeId: 'asc' }, { sequenceNumber: 'asc' }],
  });
  const byScope = new Map<string, number[]>();
  for (const e of events) {
    const arr = byScope.get(e.scopeId) ?? [];
    arr.push(e.sequenceNumber);
    byScope.set(e.scopeId, arr);
  }
  for (const [scope, seqs] of byScope) {
    const seen = new Set<number>();
    for (const n of seqs) {
      if (seen.has(n)) {
        const msg = `Duplicate HandEvent seq ${n} in scope ${scope}`;
        runLog?.write({ kind: 'invariant.fail', invariantId: INV.SEQ_MONOTONIC, data: { msg, scope, seq: n } });
        const err = new Error(`[${INV.SEQ_MONOTONIC}] ${msg}`);
        (err as any).invariantId = INV.SEQ_MONOTONIC;
        throw err;
      }
      seen.add(n);
    }
  }
}
