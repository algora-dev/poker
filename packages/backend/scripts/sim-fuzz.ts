/**
 * Phase 9 follow-up [item 5] — long fuzz runner.
 *
 * Runs N seeds x M hands of random play through the real production
 * services via the simulator. Logs any conservation violation or hard
 * error with full metadata so the failing seed can be reproduced.
 *
 * Default: 100 seeds x 50 hands x 4 random players. Override via env vars:
 *   SIM_SEEDS, SIM_HANDS, SIM_PLAYERS.
 *
 * Intentionally separated from `npm run validate` (which must stay fast).
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// We run the fuzz loop inside a vitest invocation so the existing module
// mocking pipeline works without re-creating it here.
const SEEDS = Number(process.env.SIM_SEEDS ?? 100);
const HANDS = Number(process.env.SIM_HANDS ?? 50);
const PLAYERS = Number(process.env.SIM_PLAYERS ?? 4);

const inlineTest = `
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/db/client', () => ({
  prisma: new Proxy({}, { get: (_t, prop) => {
    const w: any = (globalThis as any).__t3PokerSimWorld;
    if (!w) throw new Error('sim world not installed');
    return w[prop as string];
  } }),
}));
vi.mock('../../src/services/appLogger', () => ({ appLog: vi.fn(), logError: vi.fn() }));
vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 500_000n, bigBlind: 1_000_000n }),
}));
vi.mock('../../src/socket', () => ({
  emitGameEvent: vi.fn(), emitBalanceUpdate: vi.fn(),
  broadcastGameState: vi.fn(), checkGameRoomJoin: vi.fn(),
}));

import { runMatch } from '../../tests/sim/match';
import { randomStrategy } from '../../tests/sim/strategy';

const SEEDS = ${SEEDS};
const HANDS = ${HANDS};
const PLAYERS = ${PLAYERS};

describe('SIM FUZZ', () => {
  beforeEach(() => vi.resetModules());
  it('runs ' + SEEDS + ' seeds x ' + HANDS + ' hands x ' + PLAYERS + ' players, conservation never breaks', async () => {
    let failures: any[] = [];
    for (let s = 0; s < SEEDS; s++) {
      const seed = 1000 + s;
      const seats = Array.from({ length: PLAYERS }, (_, i) => ({
        userId: 'u_' + (i + 1) + '_' + seed,
        buyInChips: 100,
        strategy: randomStrategy(seed * 31 + i),
      }));
      const report = await runMatch({
        scenarioName: 'fuzz#' + seed,
        seed,
        seats,
        maxHands: HANDS,
      });
      if (!report.conservationOk || report.endedReason === 'error') {
        failures.push({
          seed,
          ended: report.endedReason,
          conservation: report.conservationOk,
          conservationFailure: report.conservationFailure,
          failure: report.failure,
          error: report.error,
        });
      }
    }
    if (failures.length) {
      // Pretty-print failures with bigint -> string so JSON serializes.
      const safe = JSON.stringify(failures, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2);
      throw new Error('Fuzz failures:\\n' + safe);
    }
    expect(failures.length).toBe(0);
  }, 300_000);
});
`;

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';

const BACKEND_ROOT = resolve(__dirname, '..');
const TMP_PATH = resolve(BACKEND_ROOT, 'tests/sim/__fuzz.test.ts');

function main() {
  console.log(`SIM FUZZ: ${SEEDS} seeds x ${HANDS} hands x ${PLAYERS} players`);

  if (!existsSync(resolve(BACKEND_ROOT, 'tests/sim'))) {
    mkdirSync(resolve(BACKEND_ROOT, 'tests/sim'), { recursive: true });
  }
  writeFileSync(TMP_PATH, inlineTest, 'utf8');

  try {
    const result = spawnSync(
      'npx',
      ['vitest', 'run', 'tests/sim/__fuzz.test.ts', '--testTimeout=300000'],
      {
        cwd: BACKEND_ROOT,
        shell: true,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '0' },
      }
    );
    if (result.status !== 0) {
      console.error(`SIM FUZZ FAILED (exit ${result.status})`);
      process.exit(result.status ?? 1);
    }
    console.log('SIM FUZZ PASSED');
  } finally {
    try {
      unlinkSync(TMP_PATH);
    } catch {
      /* ignore */
    }
  }
}

main();
