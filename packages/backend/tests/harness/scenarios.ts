/**
 * Scenarios — each one is a self-contained playtest spec.
 *
 * Add a new scenario by exporting an entry from `SCENARIOS` and giving it
 * an orchestration that the runHarness entry point can execute.
 */
import { runOrchestration, type OrchestrationResult } from './orchestrator';
import {
  Aggro,
  AlwaysAllIn,
  CallingStation,
  Nit,
  RandomReasonable,
  type BotStrategy,
} from './strategies';

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
    description: '4 bots; one drops + reconnects mid-session. Verify state recovery.',
    run: (env) =>
      runOrchestration({
        baseUrl: env.baseUrl,
        adminSecret: env.adminSecret,
        bots: botCfgs(env, [RandomReasonable, RandomReasonable, RandomReasonable, RandomReasonable]),
        bankrollChips: 5000,
        buyInChips: 200,
        maxHands: 15,
        timeoutMs: 5 * 60_000,
        onFirstHand: async ({ bots, gameId }) => {
          // Wait into the first hand, drop bot[2], wait, reconnect.
          await new Promise((r) => setTimeout(r, 3000));
          const target = bots[2];
          target.disconnect(true);
          await new Promise((r) => setTimeout(r, 4000));
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
        maxHands: 5,
        timeoutMs: 8 * 60_000, // each silent turn waits ~30s
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

export function listScenarios(): string[] {
  return SCENARIOS.map((s) => s.name);
}

export function getScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}

export { SCENARIOS };
