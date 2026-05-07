/**
 * Scenarios — each one is a self-contained playtest spec.
 *
 * Add a new scenario by exporting an entry from `SCENARIOS` and giving it
 * an orchestration that the runHarness entry point can execute.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { createSigner } from 'fast-jwt';
import { runOrchestration, type OrchestrationResult } from './orchestrator';
import {
  Aggro,
  AlwaysAllIn,
  CallingStation,
  Nit,
  RandomReasonable,
  type BotStrategy,
} from './strategies';

const prisma = new PrismaClient();

export interface ScenarioEnv {
  baseUrl: string;
  adminSecret: string;
  /** Suffix appended to bot emails so re-runs reuse the same accounts. */
  runSuffix?: string;
}

export interface Scenario {
  name: string;
  description: string;
  run(env: ScenarioEnv): Promise<OrchestrationResult>;
}

function botCfgs(env: ScenarioEnv, strategies: BotStrategy[], opts: Partial<{
  silentIndex: number;
  thinkMs: number;
}> = {}) {
  const suffix = env.runSuffix ?? 'v1';
  return strategies.map((s, i) => ({
    email: `bot${i + 1}.${suffix}@harness.test`,
    username: `bot${i + 1}_${suffix}`,
    password: 'harness-pw-2026!',
    strategy: s,
    silent: opts.silentIndex === i,
    thinkMs: opts.thinkMs ?? 80,
  }));
}

const SCENARIOS: Scenario[] = [
  {
    name: 'eight_player_full_session',
    description: '8 bots, mixed strategies, 30 hands. Smoke + accounting check.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [
          CallingStation,
          RandomReasonable,
          Aggro,
          Nit,
          RandomReasonable,
          Aggro,
          CallingStation,
          RandomReasonable,
        ]),
        bankrollChips: 5000,
        buyInChips: 200,
        smallBlindChips: 0.5,
        bigBlindChips: 1,
        maxHands: 30,
        timeoutMs: 6 * 60_000,
      }),
  },

  {
    name: 'all_in_storm',
    description: '4 always-all-in bots. Forces side pots, all-in showdowns hand-after-hand.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [AlwaysAllIn, AlwaysAllIn, AlwaysAllIn, AlwaysAllIn]),
        bankrollChips: 10_000,
        buyInChips: 100,
        smallBlindChips: 0.5,
        bigBlindChips: 1,
        maxHands: 20,
        timeoutMs: 4 * 60_000,
      }),
  },

  {
    name: 'disconnect_reconnect',
    description: '4 bots; one drops + reconnects between hands. Verify state recovery + ledger.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable, RandomReasonable, RandomReasonable], { thinkMs: 50 }),
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 8,
        timeoutMs: 4 * 60_000,
        onFirstHand: async ({ bots, gameId }) => {
          // Drop bot[2] briefly then reconnect. Done before serious action
          // starts so the bot has a chance to refetch state and rejoin.
          // Mid-hand disconnect-while-it's-your-turn is its own deeper test;
          // see action_timeout for the 30s timer cleanup path.
          await new Promise((r) => setTimeout(r, 800));
          const target = bots[2];
          target.disconnect(true);
          await new Promise((r) => setTimeout(r, 1500));
          await target.reconnect(gameId);
        },
      }),
  },

  {
    name: 'action_timeout',
    description: '3 bots; one is silent (never acts). Verifies 30s auto-fold path.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable, Nit], { silentIndex: 2 }),
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 3,
        timeoutMs: 4 * 60_000, // each silent turn waits ~30s; 3 hands x silent ~3 minutes
      }),
  },

  {
    name: 'cashout_mid_game',
    description: '4 bots; aggro player busts others quickly to test eliminations + game-over.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [Aggro, Aggro, AlwaysAllIn, Nit]),
        bankrollChips: 5000,
        buyInChips: 50,
        maxHands: 50, // game will end when only one bot has chips
        timeoutMs: 5 * 60_000,
      }),
  },

  {
    name: 'concurrency_blast',
    description: '6 random bots, 40 hands. Stress-test broadcast + processAction concurrency.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [
          Aggro,
          RandomReasonable,
          Aggro,
          CallingStation,
          RandomReasonable,
          Aggro,
        ], { thinkMs: 30 }),
        bankrollChips: 10_000,
        buyInChips: 500,
        maxHands: 40,
        timeoutMs: 8 * 60_000,
      }),
  },
];

// Phase 10 [H-04]: standalone scenario that exercises the active-game money
// lock at the API level. Doesn't use BotClient because we want to drive the
// /api/wallet/withdraw and /api/wallet/generate-message routes directly with
// curated state.
const moneyLockScenario: Scenario = {
  name: 'money_lock_active_game',
  description: 'Withdraw + deposit-challenge return 409 while user is seated at a waiting/in_progress table.',
  async run(env): Promise<OrchestrationResult> {
    const t0 = Date.now();
    const suffix = env.runSuffix ?? 'lock';
    const email = `lockbot.${suffix}@harness.test`.toLowerCase();
    const username = `lockbot_${suffix}`.toLowerCase();
    const password = 'harness-pw-2026!';
    // Per-suffix deterministic 40-hex wallet address so re-runs reuse the
    // same row and Prisma's unique(walletAddress) constraint is happy.
    const walletAddress = ('0x' + Buffer.from(`hlk-${suffix}`).toString('hex').padEnd(40, '0').slice(0, 40)).toLowerCase();

    // Seed user + balance
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(password, 12);
      user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { email, username, passwordHash, walletAddress },
        });
        await tx.chipBalance.create({ data: { userId: u.id, chips: 0n } });
        return u;
      });
    }
    // Ensure wallet linked (for withdraw path)
    if (!user.walletAddress) {
      await prisma.user.update({
        where: { id: user.id },
        data: { walletAddress },
      });
    }
    await prisma.chipBalance.update({
      where: { userId: user.id },
      data: { chips: 1_000_000_000n },
    });

    // Mint JWT directly (same trick as orchestrator)
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET not set');
    const signer = createSigner({ key: jwtSecret, expiresIn: 60 * 60 * 1000 });
    const token = signer({ userId: user.id });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // Create a 'waiting' game for this user with a non-zero stack so the
    // lock condition is true.
    const gameId = (
      await prisma.game.create({
        data: {
          name: `LockTest ${Date.now()}`,
          createdBy: user.id,
          smallBlind: 500_000n,
          bigBlind: 1_000_000n,
          minBuyIn: 100_000_000n,
          maxBuyIn: 100_000_000n,
          maxPlayers: 2,
          status: 'waiting',
          players: {
            create: {
              userId: user.id,
              seatIndex: 0,
              chipStack: 100_000_000n,
              position: 'waiting',
            },
          },
        },
      })
    ).id;

    try {
      // 1. Withdraw must 409 with code 'active_game_money_locked'
      const wRes = await fetch(`${env.baseUrl}/api/wallet/withdraw`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: 1 }),
      });
      if (wRes.status !== 409) {
        throw new Error(`expected 409 from /withdraw while seated, got ${wRes.status}`);
      }
      const wBody: any = await wRes.json();
      if (wBody.code !== 'active_game_money_locked') {
        throw new Error(`expected code=active_game_money_locked, got ${wBody.code}`);
      }

      // 2. /generate-message (deposit challenge) must 409 too.
      const gRes = await fetch(`${env.baseUrl}/api/wallet/generate-message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ walletAddress }),
      });
      if (gRes.status !== 409) {
        throw new Error(`expected 409 from /generate-message while seated, got ${gRes.status}`);
      }
      const gBody: any = await gRes.json();
      if (gBody.code !== 'active_game_money_locked') {
        throw new Error(`expected code=active_game_money_locked, got ${gBody.code}`);
      }

      // 3. /money-lock should report locked=true with the right gameId.
      const lRes = await fetch(`${env.baseUrl}/api/wallet/money-lock`, { headers });
      const lBody: any = await lRes.json();
      if (lBody.locked !== true || lBody.gameId !== gameId) {
        throw new Error(`/money-lock not reporting lock: ${JSON.stringify(lBody)}`);
      }

      // 4. Phase 10 [H-04] hardening: a player who is all-in (chipStack=0
      //    but seat still attached to an in_progress game) must STILL be
      //    locked. Flip the GamePlayer to chipStack=0 / all_in and confirm.
      await prisma.gamePlayer.updateMany({
        where: { userId: user.id, gameId },
        data: { chipStack: 0n, position: 'all_in' },
      });
      await prisma.game.update({ where: { id: gameId }, data: { status: 'in_progress' } });
      const lAllInRes = await fetch(`${env.baseUrl}/api/wallet/money-lock`, { headers });
      const lAllInBody: any = await lAllInRes.json();
      if (lAllInBody.locked !== true) {
        throw new Error(
          `/money-lock not locked for all-in seat (chipStack=0): ${JSON.stringify(lAllInBody)}`
        );
      }
      const wAllInRes = await fetch(`${env.baseUrl}/api/wallet/withdraw`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: 1 }),
      });
      if (wAllInRes.status !== 409) {
        throw new Error(
          `expected 409 from /withdraw while all-in (chipStack=0), got ${wAllInRes.status}`
        );
      }

      // 5. Folded but still seated: same. Position transitions back to
      //    'folded' between hands.
      await prisma.gamePlayer.updateMany({
        where: { userId: user.id, gameId },
        data: { position: 'folded', chipStack: 0n },
      });
      const lFoldedRes = await fetch(`${env.baseUrl}/api/wallet/money-lock`, { headers });
      const lFoldedBody: any = await lFoldedRes.json();
      if (lFoldedBody.locked !== true) {
        throw new Error(
          `/money-lock not locked for folded seat: ${JSON.stringify(lFoldedBody)}`
        );
      }

      // 6. Trying to create a NEW game while seated must 409 too.
      const cRes = await fetch(`${env.baseUrl}/api/games/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `BadCreate ${Date.now()}`,
          minBuyIn: 1,
          maxBuyIn: 1,
          creatorBuyIn: 1,
          smallBlind: 0.5,
          bigBlind: 1,
        }),
      });
      if (cRes.status !== 409) {
        throw new Error(
          `expected 409 from /games/create while seated, got ${cRes.status}: ${await cRes.text()}`
        );
      }
      const cBody: any = await cRes.json();
      if (cBody.code !== 'active_game_money_locked') {
        throw new Error(`expected code=active_game_money_locked, got ${cBody.code}`);
      }

      // 7. Deposit credit-time check: simulate the listener trying to
      //    credit while the user is still seated. Requires a stub
      //    DepositAuthorization; the helper acquires the per-user money
      //    mutex, sees the lock, and skips the credit. ChipBalance must
      //    not change. A Deposit row is written with confirmed=false for
      //    operator visibility (idempotency only — not a normal flow).
      const { createDepositChallenge } = await import('../../src/services/wallet');
      const challenge = await createDepositChallenge({
        userId: user.id,
        walletAddress,
        amount: 1_000_000n,
      });
      // Insert the auth row directly (bypassing signature flow) so the
      // listener has something to consume. We mark it used=false.
      const depositAuth = await prisma.depositAuthorization.create({
        data: {
          userId: user.id,
          walletAddress: walletAddress,
          nonce: challenge.nonce,
          chainId: challenge.chainId,
          contractAddress: challenge.contractAddress,
          amount: 1_000_000n,
          issuedAt: challenge.issuedAt,
          expiresAt: challenge.expiresAt,
          signature: 'harness-stub',
          message: challenge.challenge,
        },
      });
      const txHash = '0x' + 'd0' + Date.now().toString(16).padStart(16, '0').padEnd(62, '0');
      const balanceBeforeCredit = (
        await prisma.chipBalance.findUnique({ where: { userId: user.id } })
      )!.chips;
      // Drive creditChips directly with the helper. It must NOT credit.
      const { creditChipsForTesting } = await import('../../src/blockchain/listener');
      await creditChipsForTesting(walletAddress, 1_000_000n, txHash, 999_999_999);
      const balanceAfterCredit = (
        await prisma.chipBalance.findUnique({ where: { userId: user.id } })
      )!.chips;
      if (balanceAfterCredit !== balanceBeforeCredit) {
        throw new Error(
          `Deposit credited while user was seated: before=${balanceBeforeCredit} after=${balanceAfterCredit}`
        );
      }
      // Auth must remain unconsumed.
      const authAfter = await prisma.depositAuthorization.findUnique({
        where: { id: depositAuth.id },
      });
      if (!authAfter || authAfter.used) {
        throw new Error(
          `Authorization was consumed during deferred deposit (should still be usable)`
        );
      }
      // Deferred Deposit row must be present with confirmed=false.
      const deferredRow = await prisma.deposit.findUnique({ where: { txHash } });
      if (!deferredRow || deferredRow.confirmed !== false) {
        throw new Error(
          `Expected deferred Deposit row with confirmed=false, got ${JSON.stringify(deferredRow)}`
        );
      }

      // 8. Free the user (close game) and re-check: lock clears.
      const { closeGame } = await import('../../src/services/closeGame');
      await closeGame({ gameId, reason: 'admin_cancel', notes: 'lock-test cleanup' });
      const lRes2 = await fetch(`${env.baseUrl}/api/wallet/money-lock`, { headers });
      const lBody2: any = await lRes2.json();
      if (lBody2.locked !== false) {
        throw new Error(`/money-lock still locked after close: ${JSON.stringify(lBody2)}`);
      }
    } finally {
      // Best-effort cleanup if assertion threw before reaching the close.
      const stillThere = await prisma.game.findUnique({ where: { id: gameId } });
      if (stillThere && stillThere.status !== 'completed' && stillThere.status !== 'cancelled') {
        try {
          const { closeGame } = await import('../../src/services/closeGame');
          await closeGame({ gameId, reason: 'admin_cancel', notes: 'lock-test cleanup (finally)' });
        } catch {
          /* ignore */
        }
      }
    }

    // Return the same shape the orchestrator does.
    return {
      gameId,
      handsCompleted: 0,
      durationMs: Date.now() - t0,
      bots: [],
    };
  },
};

SCENARIOS.push(moneyLockScenario);

export function listScenarios(): string[] {
  return SCENARIOS.map((s) => s.name);
}

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}

export { SCENARIOS };
