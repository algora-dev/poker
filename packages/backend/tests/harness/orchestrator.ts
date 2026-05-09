/**
 * Orchestrator — runs N bots through one game from start to finish.
 *
 * Responsible for:
 *  - admin-topping-up bot bankrolls
 *  - creating a game (creator bot)
 *  - having the rest join
 *  - starting the game
 *  - waiting for either: hand limit reached, only one player left, or hard timeout
 *  - running invariants throughout
 *  - tearing down sockets
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { createSigner } from 'fast-jwt';
import { BotClient, type BotConfig } from './botClient';
import {
  assertBotsHealthy,
  assertChipsConserved,
  assertClosedGamesAreEmpty,
  assertHandEventSequencesMonotonic,
  assertNoStalls,
  assertSessionLedger,
} from './invariants';

export interface OrchestrationOptions {
  baseUrl: string;
  adminSecret: string;
  /** Bot configs (will be created/logged-in). */
  bots: Array<Omit<BotConfig, 'baseUrl'>>;
  /** Chips each bot starts with (top-up via admin endpoint to reach this floor). */
  bankrollChips: number;
  /** Buy-in per bot when joining the game. */
  buyInChips: number;
  smallBlindChips?: number;
  bigBlindChips?: number;
  /** Stop after this many hands have completed. */
  maxHands?: number;
  /** Hard timeout in ms. */
  timeoutMs?: number;
  /** Optional callback for scenario-specific orchestration steps. */
  onTick?: (ctx: TickContext) => void | Promise<void>;
  /** Optional one-time hook fired after the first hand starts. */
  onFirstHand?: (ctx: TickContext) => void | Promise<void>;
}

export interface TickContext {
  bots: BotClient[];
  gameId: string;
  handsCompleted: number;
  prisma: PrismaClient;
}

export interface OrchestrationResult {
  gameId: string;
  handsCompleted: number;
  durationMs: number;
  bots: BotClient[];
}

const prisma = new PrismaClient();

export async function runOrchestration(opts: OrchestrationOptions): Promise<OrchestrationResult> {
  const startedAt = Date.now();
  const baseUrl = opts.baseUrl;

  const bots = opts.bots.map((c) => new BotClient({ ...c, baseUrl }));
  const bankrollMicro = BigInt(Math.floor(opts.bankrollChips * 1_000_000));

  // 1. Pre-seed bot accounts directly so we never hit the public signup
  //    rate limit (5/hour/IP). This is harness-only — production users still
  //    go through /api/auth/signup with rate limiting intact.
  const userIdsByBot: string[] = [];
  for (const b of bots) {
    let existing = await prisma.user.findUnique({
      where: { email: b.cfg.email.toLowerCase() },
    });
    if (!existing) {
      const passwordHash = await bcrypt.hash(b.cfg.password, 12);
      existing = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email: b.cfg.email.toLowerCase(),
            username: b.cfg.username.toLowerCase(),
            passwordHash,
          },
        });
        await tx.chipBalance.create({ data: { userId: u.id, chips: 0n } });
        return u;
      });
    }
    userIdsByBot.push(existing!.id);
  }

  // 2. Mint JWTs directly using JWT_SECRET so we bypass the login
  //    rate limit (10/min/IP). This is harness-only; the real login flow
  //    is exercised separately by integration tests.
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET not set; harness cannot mint tokens');
  const signer = createSigner({ key: jwtSecret, expiresIn: 60 * 60 * 1000 });
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i];
    b.userId = userIdsByBot[i];
    b.token = signer({ userId: userIdsByBot[i] });
  }

  // 2. Top up bankrolls via admin endpoint, only adding the difference if any.
  //    This means a re-run with the same bots is fast and idempotent.
  const startingBalances = new Map<string, bigint>();
  for (const b of bots) {
    const bal = await prisma.chipBalance.findUnique({ where: { userId: b.userId! } });
    const cur = bal?.chips ?? 0n;
    if (cur < bankrollMicro) {
      const need = bankrollMicro - cur;
      const needChips = Number(need) / 1_000_000;
      const res = await fetch(`${baseUrl}/api/admin/add-chips`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret: opts.adminSecret,
          email: b.cfg.email,
          amount: needChips,
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Failed to top up ${b.cfg.email}: ${res.status} ${await res.text()}`
        );
      }
    }
    const after = await prisma.chipBalance.findUnique({ where: { userId: b.userId! } });
    startingBalances.set(b.userId!, after?.chips ?? 0n);
  }

  // 3. Connect all sockets and start watchdogs
  for (const b of bots) {
    await b.connectSocket();
    b.startWatchdog();
  }

  // 4. First bot creates the game
  const creator = bots[0];
  const createBody: any = {
    name: `Harness ${Date.now()}`,
    minBuyIn: opts.buyInChips,
    maxBuyIn: opts.buyInChips,
    creatorBuyIn: opts.buyInChips,
    smallBlind: opts.smallBlindChips ?? 0.5,
    bigBlind: opts.bigBlindChips ?? 1,
  };
  const createRes = await creator.postJson('/api/games/create', createBody);
  if (!createRes.ok) {
    throw new Error(`create game failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = await createRes.json();
  const gameId: string = created.game.id;

  // 5. Creator socket joins room first (creator is auto-seated by createGame).
  await creator.joinGameRoom(gameId);

  // 6. Other bots join the game via REST (they get seated server-side),
  //    THEN their sockets can join the private game room.
  for (const b of bots.slice(1)) {
    const r = await b.postJson(`/api/games/${gameId}/join`, { buyInAmount: opts.buyInChips });
    if (!r.ok) {
      throw new Error(`bot ${b.cfg.email} join failed: ${r.status} ${await r.text()}`);
    }
    await b.joinGameRoom(gameId);
  }

  // 7. Track hands completed via showdown / new-hand events.
  let handsCompleted = 0;
  let firstHandFired = false;
  for (const b of bots) {
    b.events.onShowdown = () => {
      handsCompleted++;
    };
  }

  // 8. Creator starts the game
  const startRes = await creator.postJson(`/api/games/${gameId}/start`, {});
  if (!startRes.ok) {
    throw new Error(`start failed: ${startRes.status} ${await startRes.text()}`);
  }

  // 9. Drive the loop.
  // Compute initial chips ON the table (what the engine should conserve).
  const initialChipsTotal = BigInt(opts.bots.length) * BigInt(Math.floor(opts.buyInChips * 1_000_000));
  const ctx = {
    gameId,
    bots,
    initialChipsTotal,
    prisma,
  };

  const maxHands = opts.maxHands ?? 10;
  const deadline = startedAt + (opts.timeoutMs ?? 5 * 60_000);

  while (handsCompleted < maxHands && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!firstHandFired) {
      firstHandFired = true;
      try {
        await opts.onFirstHand?.({ bots, gameId, handsCompleted, prisma });
      } catch (e: any) {
        bots[0].errors.push(`onFirstHand: ${e.message}`);
      }
    }
    try {
      await opts.onTick?.({ bots, gameId, handsCompleted, prisma });
    } catch (e: any) {
      bots[0].errors.push(`onTick: ${e.message}`);
    }
    // Per-tick invariants
    assertNoStalls(ctx);
    await assertChipsConserved(ctx);

    // Game may end early (only one player left with chips).
    const live = await prisma.gamePlayer.count({
      where: { gameId, position: { not: 'eliminated' } },
    });
    const gameRow = await prisma.game.findUnique({ where: { id: gameId } });
    if (live <= 1 || gameRow?.status === 'completed') break;
  }

  // 10. Final invariants
  await assertChipsConserved(ctx);
  assertBotsHealthy(ctx);
  await assertHandEventSequencesMonotonic(prisma);
  await assertClosedGamesAreEmpty(prisma);
  await assertSessionLedger(ctx, startingBalances);

  // 11. Cleanup
  for (const b of bots) b.shutdown();

  return {
    gameId,
    handsCompleted,
    durationMs: Date.now() - startedAt,
    bots,
  };
}

export { prisma as harnessPrisma };
