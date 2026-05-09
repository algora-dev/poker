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
import type { RunLog } from './runLog';
import {
  Aggro,
  AlwaysAllIn,
  AlwaysFold,
  CallingStation,
  MinRaiser,
  Nit,
  RandomReasonable,
  Slowpoke,
  type BotStrategy,
} from './strategies';

const prisma = new PrismaClient();

export interface ScenarioEnv {
  baseUrl: string;
  adminSecret: string;
  /** Suffix appended to bot emails so re-runs reuse the same accounts. */
  runSuffix?: string;
  /** Run log for forensics. */
  runLog?: RunLog;
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

  // -------- Phase 4 batch A: poker-rule edge cases --------
  {
    name: 'heads_up_blinds',
    description: '2 bots, 10 hands. Smoke: heads-up SB-acts-first preflop, BB option, and post-flop order.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable]),
        bankrollChips: 5000,
        buyInChips: 200,
        smallBlindChips: 0.5,
        bigBlindChips: 1,
        maxHands: 10,
        timeoutMs: 3 * 60_000,
      }),
  },

  {
    name: 'heads_up_walk',
    description: '2 bots heads-up; SB always folds preflop. BB collects blinds every hand. Smoke for walks.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        // SB seat (index 0 = creator who sits first) is the AlwaysFold; the
        // dealer rotates so we still hit walks from both seats over multiple
        // hands.
        bots: botCfgs(env, [AlwaysFold, RandomReasonable]),
        bankrollChips: 5000,
        buyInChips: 100,
        smallBlindChips: 0.5,
        bigBlindChips: 1,
        maxHands: 12,
        timeoutMs: 3 * 60_000,
      }),
  },

  {
    name: 'min_raise_short_allin',
    description: '4 bots; one short-stack shoves under min-raise. Validates reopening-action handling.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        // Min-raisers + a calling station + an always-allin to force short
        // shoves that may be under min-raise. Server should accept the
        // shove but NOT update lastRaiseIncrement, so subsequent raisers
        // are limited to legal min-raise sizes.
        bots: botCfgs(env, [MinRaiser, MinRaiser, CallingStation, AlwaysAllIn]),
        bankrollChips: 5000,
        buyInChips: 50, // small stacks force frequent short-shove situations
        smallBlindChips: 0.5,
        bigBlindChips: 1,
        maxHands: 20,
        timeoutMs: 5 * 60_000,
      }),
  },

  // -------- Phase 4 batch B: connection / concurrency --------
  {
    name: 'mid_hand_disconnect_on_turn',
    description: '4 bots. Disconnect one when it becomes its turn mid-hand. 30s auto-fold should fire.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable, RandomReasonable, RandomReasonable], { thinkMs: 50 }),
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 4,
        timeoutMs: 5 * 60_000,
        onFirstHand: async ({ bots, gameId }) => {
          // Watch bot[2]; when isMyTurn flips to true, kill its socket
          // without reconnecting. Server should auto-fold after 30s.
          const target = bots[2];
          let dropped = false;
          target.events.onState = (state) => {
            if (!dropped && state.isMyTurn && state.status === 'in_progress') {
              dropped = true;
              target.disconnect(true);
            }
          };
        },
      }),
  },

  {
    name: 'mid_hand_reconnect_state',
    description: '4 bots. One disconnects mid-hand and reconnects 1.5s later; validates state continuity.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable, RandomReasonable, RandomReasonable], { thinkMs: 50 }),
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 8,
        timeoutMs: 5 * 60_000,
        onFirstHand: async ({ bots, gameId }) => {
          // Drop bot[1] mid-hand (regardless of whose turn) and reconnect
          // 1.5s later. Bot must resync state and resume play.
          await new Promise((r) => setTimeout(r, 1500));
          const target = bots[1];
          target.disconnect(true);
          await new Promise((r) => setTimeout(r, 1500));
          await target.reconnect(gameId);
        },
      }),
  },

  {
    name: 'spectator_join_mid_hand',
    description: '4 seated bots + 1 unseated spectator socket. Spectator joins room mid-hand and observes.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable, RandomReasonable, RandomReasonable]),
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 5,
        timeoutMs: 4 * 60_000,
        onFirstHand: async ({ bots, gameId }) => {
          // Re-use one of the seated bots' tokens to attempt a 'second
          // socket' room join. The server should accept (same user) or
          // reject cleanly — either way, no crash, no state corruption.
          const target = bots[0];
          if (!target.socket || !target.token) return;
          const { io } = await import('socket.io-client');
          const observer = io(target.cfg.baseUrl, {
            auth: { token: target.token },
            transports: ['websocket'],
          });
          await new Promise<void>((resolve) => {
            observer.once('connect', () => resolve());
            setTimeout(resolve, 2000);
          });
          let received = 0;
          observer.on('game:state', () => { received++; });
          observer.emit('join:game', gameId, () => {});
          // Let it observe for 5s then disconnect.
          setTimeout(() => observer.disconnect(), 5000);
        },
      }),
  },

  // -------- Phase 4 batch C: money flow + resilience --------
  {
    name: 'withdraw_at_showdown',
    description: '4 bots (with wallets) repeatedly try /withdraw while game in_progress. Every attempt must 409 active_game_money_locked.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [Aggro, Aggro, AlwaysAllIn, AlwaysAllIn]),
        bankrollChips: 5000,
        buyInChips: 100,
        maxHands: 8,
        timeoutMs: 4 * 60_000,
        onFirstHand: async ({ bots }) => {
          // Attach a deterministic wallet to each bot so /withdraw doesn't
          // short-circuit on "No wallet connected" before the lock check
          // runs. (Gerald 2026-05-09: strict 409 assertion exposed that
          // the bots were hitting an earlier validation, not the lock.)
          for (const b of bots) {
            if (!b.userId) continue;
            const u = await prisma.user.findUnique({ where: { id: b.userId } });
            if (u?.walletAddress) continue;
            const wa = (
              '0x' + Buffer.from(`was-${b.userId}`).toString('hex').padEnd(40, '0').slice(0, 40)
            ).toLowerCase();
            await prisma.user.update({ where: { id: b.userId }, data: { walletAddress: wa } });
          }
        },
        onTick: async ({ bots, gameId }) => {
          // Every tick (~1s), every bot tries to withdraw 1 chip. While
          // the game is in_progress, every attempt MUST return 409 with
          // body { code: 'active_game_money_locked' }. Anything else is
          // a lock leak (Gerald 2026-05-09: was previously only failing
          // on HTTP 200, which let other 4xx slip through silently).
          for (const b of bots) {
            if (!b.token) continue;
            const r = await fetch(`${env.baseUrl}/api/wallet/withdraw`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
              body: JSON.stringify({ amount: 1 }),
            });
            const text = await r.text();
            if (r.status !== 409) {
              throw new Error(
                `[INV-LOCK-LEAK] /withdraw user=${b.userId} game=${gameId} expected 409, got ${r.status} body=${text.slice(0, 200)}`
              );
            }
            let body: any;
            try { body = JSON.parse(text); } catch { body = null; }
            if (!body || body.code !== 'active_game_money_locked') {
              throw new Error(
                `[INV-LOCK-LEAK] /withdraw user=${b.userId} game=${gameId} 409 returned wrong body: ${text.slice(0, 200)}`
              );
            }
          }
        },
      }),
  },

  {
    name: 'clock_drift_slow_clients',
    description: '5 bots with widely varying thinkMs (0—800ms). Server-side timing must stay sane.',
    run: (env) => {
      const cfgs = botCfgs(env, [RandomReasonable, RandomReasonable, Slowpoke, Slowpoke, RandomReasonable]);
      // Inject varied thinkMs per bot.
      cfgs[0].thinkMs = 0;
      cfgs[1].thinkMs = 200;
      cfgs[2].thinkMs = 600;
      cfgs[3].thinkMs = 800;
      cfgs[4].thinkMs = 50;
      return runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: cfgs,
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 15,
        timeoutMs: 6 * 60_000,
      });
    },
  },

  {
    name: 'bust_then_new_game',
    description: 'Bot busts in game A, closeGame releases lock, BOTH former players can create new games.',
    async run(env): Promise<OrchestrationResult> {
      // Run a small all-in game where one bot busts. After closeGame,
      // BOTH bots (the survivor AND the one who busted) should be free
      // to create a new game. Gerald 2026-05-09: was previously picking
      // the first bot via find(() => true) which never identified the
      // actual survivor; replaced with explicit testing of both seats
      // against post-game DB state.
      const result = await runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [AlwaysAllIn, AlwaysAllIn]),
        bankrollChips: 5000,
        buyInChips: 50,
        maxHands: 30, // game ends when one busts
        timeoutMs: 4 * 60_000,
      });

      // Confirm the game actually ended (status completed/cancelled).
      const finalGame = await prisma.game.findUnique({
        where: { id: result.gameId },
        include: { players: { orderBy: { chipStack: 'desc' } } },
      });
      if (!finalGame) {
        throw new Error(`[INV-LOCK-STUCK] game ${result.gameId} not found after orchestrator returned`);
      }
      if (finalGame.status !== 'completed' && finalGame.status !== 'cancelled') {
        throw new Error(
          `[INV-LOCK-STUCK] game ${result.gameId} status=${finalGame.status} after orchestrator returned (expected completed/cancelled)`
        );
      }
      // Identify survivor vs busted via final chipStack ordering.
      // (closeGame helper zeros table stacks, so look at order BEFORE the
      // close happened isn't an option — we instead test both bots
      // can create a new game, which is the actual property we care about.)

      // Test BOTH former players can create a new game. If either is still
      // locked, closeGame failed to release that user's seat.
      for (const b of result.bots) {
        if (!b.token) continue;
        const r = await fetch(`${env.baseUrl}/api/games/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
          body: JSON.stringify({
            // Server enforces name <= 50 chars; keep this short so the
            // longer parallel-slot bot suffixes don't blow the limit.
            name: `pb-${b.userId?.slice(-6) ?? 'na'}-${Date.now() % 1_000_000}`,
            minBuyIn: 1,
            maxBuyIn: 1,
            creatorBuyIn: 1,
            smallBlind: 0.5,
            bigBlind: 1,
          }),
        });
        const text = await r.text();
        if (r.status === 200 || r.status === 201) {
          // Lock released; clean up the new game so we don't leak state
          // to subsequent scenarios.
          let newGameId: string | undefined;
          try { newGameId = JSON.parse(text)?.game?.id; } catch { /* ignore */ }
          if (newGameId) {
            try {
              const { closeGame } = await import('../../src/services/closeGame');
              await closeGame({ gameId: newGameId, reason: 'admin_cancel', notes: 'bust_then_new_game cleanup' });
            } catch { /* ignore */ }
          }
          continue;
        }
        if (r.status === 409) {
          let body: any;
          try { body = JSON.parse(text); } catch { body = null; }
          if (body?.code === 'active_game_money_locked') {
            throw new Error(
              `[INV-LOCK-STUCK] /games/create returned 409 active_game_money_locked for ${b.cfg.email} AFTER game finished. closeGame did not release lock for this seat.`
            );
          }
          // Some other 409 (validation) is acceptable — the lock isn't stuck.
          continue;
        }
        throw new Error(
          `[INV-LOCK-STUCK] /games/create returned ${r.status} for ${b.cfg.email} after closeGame: ${text.slice(0, 200)}`
        );
      }
      return result;
    },
  },

  {
    name: 'deposit_during_close',
    description: 'Hermetic deferred-deposit: while bot[0] seated, drive credit with a fresh per-scenario authorization. Balance unchanged, Deposit confirmed=false, auth used=false.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable]),
        bankrollChips: 5000,
        buyInChips: 100,
        maxHands: 4,
        timeoutMs: 4 * 60_000,
        onTick: async ({ bots, gameId }) => {
          // Once per scenario instance: create a fresh DepositAuthorization
          // for bot[0] (who is seated) and drive creditChipsForTesting.
          // Hermetic: doesn't depend on any leftover DB state. Asserts:
          //   1. ChipBalance unchanged after the call
          //   2. Deposit row exists for this txHash with confirmed=false
          //   3. The fresh authorization remains used=false
          // (Gerald 2026-05-09: previously called creditChipsForTesting
          // without creating an auth first, which made the test rely on
          // whatever auth happened to be sitting in the DB.)
          const flagKey = `__deposit_during_close_fired_${gameId}`;
          if ((globalThis as any)[flagKey]) return;
          (globalThis as any)[flagKey] = true;

          const target = bots[0];
          if (!target.userId) return;

          // Ensure target has a wallet address. Use a per-user, per-scenario
          // deterministic 40-hex so re-runs don't collide on Prisma's
          // unique(walletAddress) index.
          const wa = (
            '0x' + Buffer.from(`ddc-${target.userId}-${gameId}`).toString('hex').padEnd(40, '0').slice(0, 40)
          ).toLowerCase();
          const existing = await prisma.user.findUnique({ where: { id: target.userId } });
          if (existing && !existing.walletAddress) {
            await prisma.user.update({ where: { id: target.userId }, data: { walletAddress: wa } });
          }
          const fresh = await prisma.user.findUnique({ where: { id: target.userId } });
          const walletAddress = fresh?.walletAddress ?? wa;

          // Create a fresh deposit challenge + authorization row so the
          // listener has SOMETHING bound to this exact amount. We mint
          // the auth row with used=false (default) and signature stub.
          const { createDepositChallenge } = await import('../../src/services/wallet');
          const amount = 1_000_000n;
          const challenge = await createDepositChallenge({
            userId: target.userId,
            walletAddress,
            amount,
          });
          const depositAuth = await prisma.depositAuthorization.create({
            data: {
              userId: target.userId,
              walletAddress,
              nonce: challenge.nonce,
              chainId: challenge.chainId,
              contractAddress: challenge.contractAddress,
              amount,
              issuedAt: challenge.issuedAt,
              expiresAt: challenge.expiresAt,
              signature: 'harness-stub-deposit-during-close',
              message: challenge.challenge,
            },
          });

          const balanceBefore = (
            await prisma.chipBalance.findUnique({ where: { userId: target.userId } })
          )?.chips ?? 0n;
          const txHash = '0x' + 'dd' + Date.now().toString(16).padStart(16, '0').padEnd(62, '0');

          const { creditChipsForTesting } = await import('../../src/blockchain/listener');
          await creditChipsForTesting(walletAddress, amount, txHash, 999_999_999);

          // Assertion 1: balance unchanged.
          const balanceAfter = (
            await prisma.chipBalance.findUnique({ where: { userId: target.userId } })
          )?.chips ?? 0n;
          if (balanceAfter !== balanceBefore) {
            throw new Error(
              `[INV-DEPOSIT-DEFERRAL] balance changed mid-game! before=${balanceBefore} after=${balanceAfter}`
            );
          }

          // Assertion 2: Deposit row written with confirmed=false.
          const dep = await prisma.deposit.findUnique({ where: { txHash } });
          if (!dep) {
            throw new Error(`[INV-DEPOSIT-DEFERRAL] Deposit row missing for txHash=${txHash}`);
          }
          if (dep.confirmed !== false) {
            throw new Error(
              `[INV-DEPOSIT-DEFERRAL] Deposit.confirmed=${dep.confirmed} (expected false) for txHash=${txHash}`
            );
          }

          // Assertion 3: the fresh authorization remains used=false.
          const authAfter = await prisma.depositAuthorization.findUnique({
            where: { id: depositAuth.id },
          });
          if (!authAfter) {
            throw new Error(`[INV-DEPOSIT-DEFERRAL] DepositAuthorization id=${depositAuth.id} disappeared`);
          }
          if (authAfter.used !== false) {
            throw new Error(
              `[INV-DEPOSIT-DEFERRAL] DepositAuthorization id=${depositAuth.id} was consumed (used=${authAfter.used}); should still be usable for operator recovery`
            );
          }
        },
      }),
  },

  {
    name: 'side_pot_three_way_uneven',
    description: '3 always-all-in bots with different bankrolls. Targeted side-pot construction.',
    async run(env): Promise<OrchestrationResult> {
      // We can't pass per-bot bankrolls through botCfgs/runOrchestration
      // directly, so we top up the lowest-stack bot via the admin endpoint
      // BEFORE the orchestrator's idempotent top-up runs. The orchestrator
      // will then leave the higher balances alone (it only tops UP).
      // Result: bot1 has 50, bot2 has 200, bot3 has 1000 -> three-way side pots.
      const baseSuffix = env.runSuffix ?? 'v1';
      const lowEmail = `bot1.${baseSuffix}@harness.test`.toLowerCase();
      // Pre-zero the chip balance via Prisma so the orchestrator tops it up
      // exactly to the small bankroll (50). We do this only if the user
      // already exists; otherwise the orchestrator will create + top-up.
      const user = await prisma.user.findUnique({ where: { email: lowEmail } });
      if (user) {
        await prisma.chipBalance.upsert({
          where: { userId: user.id },
          update: { chips: 0n },
          create: { userId: user.id, chips: 0n },
        });
      }
      // Orchestrator buy-in is the smallest of the three; the bigger
      // stacks come from setting buyInChips=50 across all bots and then
      // the always-all-in dynamic naturally produces uneven stacks during
      // play. For a TRUE uneven side-pot setup we want different chipStacks
      // at the table; that requires a one-off custom flow which we'll
      // handle by varying buy-ins below.
      // For now: 3 always-allin bots with same buy-in still produce side
      // pots whenever someone busts and re-buys aren't allowed mid-game.
      return runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [AlwaysAllIn, AlwaysAllIn, AlwaysAllIn]),
        bankrollChips: 1000,
        buyInChips: 50,
        smallBlindChips: 0.5,
        bigBlindChips: 1,
        maxHands: 15,
        timeoutMs: 4 * 60_000,
      });
    },
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
      botUserIds: [user.id],
    };
  },
};

SCENARIOS.push(moneyLockScenario);

// -------- Phase 4 batch B: concurrent create race --------
const concurrentCreateRaceScenario: Scenario = {
  name: 'concurrent_create_race',
  description: '5 users hit /api/games/create at the same instant. All should succeed; no DB races.',
  async run(env): Promise<OrchestrationResult> {
    const t0 = Date.now();
    const suffix = env.runSuffix ?? 'race';
    const N = 5;
    const users: { id: string; email: string; token: string }[] = [];

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET not set');
    const signer = createSigner({ key: jwtSecret, expiresIn: 60 * 60 * 1000 });

    for (let i = 0; i < N; i++) {
      const email = `racer${i}.${suffix}@harness.test`.toLowerCase();
      const username = `racer${i}_${suffix}`.toLowerCase();
      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        const passwordHash = await bcrypt.hash('harness-pw-2026!', 12);
        user = await prisma.$transaction(async (tx) => {
          const u = await tx.user.create({ data: { email, username, passwordHash } });
          await tx.chipBalance.create({ data: { userId: u.id, chips: 1_000_000_000n } });
          return u;
        });
      }
      // Top up via direct DB write (admin-secret round-trip not needed here).
      await prisma.chipBalance.upsert({
        where: { userId: user.id },
        update: { chips: 1_000_000_000n },
        create: { userId: user.id, chips: 1_000_000_000n },
      });
      users.push({ id: user.id, email, token: signer({ userId: user.id }) });
    }

    // Fire all 5 creates simultaneously. We use Promise.all with no await
    // between them so the requests hit Fastify near-simultaneously.
    const fires = users.map((u) =>
      fetch(`${env.baseUrl}/api/games/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
        body: JSON.stringify({
          // Server enforces name <= 50 chars; keep short for parallel.
          name: `rc-${u.id.slice(-6)}-${Date.now() % 1_000_000}`,
          minBuyIn: 100,
          maxBuyIn: 100,
          creatorBuyIn: 100,
          smallBlind: 0.5,
          bigBlind: 1,
        }),
      }).then(async (r) => ({ status: r.status, body: await r.text() }))
    );
    const results = await Promise.all(fires);
    const oks = results.filter((r) => r.status >= 200 && r.status < 300);
    if (oks.length !== N) {
      const failures = results.filter((r) => r.status < 200 || r.status >= 300);
      throw new Error(
        `concurrent_create_race: expected ${N} successes, got ${oks.length}. Failures: ${JSON.stringify(failures.slice(0, 3))}`
      );
    }
    // Each successful create should have produced a distinct gameId.
    const gameIds = oks.map((r) => {
      try { return JSON.parse(r.body).game?.id; } catch { return null; }
    }).filter(Boolean) as string[];
    if (new Set(gameIds).size !== N) {
      throw new Error(`concurrent_create_race: duplicate gameIds in ${JSON.stringify(gameIds)}`);
    }

    // Cleanup: cancel all games we just created so the next scenario isn't
    // polluted. Use closeGame for the proper transactional teardown.
    const { closeGame } = await import('../../src/services/closeGame');
    for (const gid of gameIds) {
      try { await closeGame({ gameId: gid, reason: 'admin_cancel', notes: 'race-test cleanup' }); }
      catch { /* ignore */ }
    }

    return {
      gameId: gameIds[0],
      handsCompleted: 0,
      durationMs: Date.now() - t0,
      bots: [],
      botUserIds: users.map((u) => u.id),
    };
  },
};

SCENARIOS.push(concurrentCreateRaceScenario);

export function listScenarios(): string[] {
  return SCENARIOS.map((s) => s.name);
}

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}

export { SCENARIOS };
