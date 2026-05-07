/**
 * Harness entry point.
 *
 * env vars:
 *   HARNESS_BASE_URL       (default http://localhost:3000)
 *   HARNESS_ADMIN_SECRET   (required to top up bot bankrolls)
 *   HARNESS_SCENARIO       (default: run all)
 *   HARNESS_RUN_SUFFIX     (default: timestamped; set to a stable string for re-runnable bots)
 *
 * Exit code 0 on full success, non-zero on any failure.
 */
import { config as loadEnv } from 'dotenv';
import * as path from 'path';
// Load packages/backend/.env regardless of where the harness is invoked from.
loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

import { getScenario, listScenarios, SCENARIOS, type ScenarioEnv } from './scenarios';
import { harnessPrisma } from './orchestrator';

async function main() {
  const baseUrl = process.env.HARNESS_BASE_URL ?? 'http://localhost:3000';
  const adminSecret = process.env.HARNESS_ADMIN_SECRET;
  if (!adminSecret) {
    console.error('FAIL: HARNESS_ADMIN_SECRET is required');
    process.exit(2);
  }
  const onlyScenario = process.env.HARNESS_SCENARIO;
  // Use a STABLE suffix by default so bot accounts can be reused across runs.
  // Override with HARNESS_RUN_SUFFIX=fresh_$(date) when you need cleanroom users.
  const runSuffix = process.env.HARNESS_RUN_SUFFIX ?? 'persist1';

  const env: ScenarioEnv = { baseUrl, adminSecret, runSuffix };

  // Quick reachability check.
  try {
    const r = await fetch(`${baseUrl}/health`);
    if (!r.ok) throw new Error(`health ${r.status}`);
  } catch (e: any) {
    console.error(`FAIL: backend not reachable at ${baseUrl}: ${e.message}`);
    process.exit(2);
  }

  const scenarios = onlyScenario
    ? [getScenario(onlyScenario)].filter(Boolean) as typeof SCENARIOS
    : SCENARIOS;
  if (onlyScenario && scenarios.length === 0) {
    console.error(`FAIL: unknown scenario '${onlyScenario}'. Known: ${listScenarios().join(', ')}`);
    process.exit(2);
  }

  console.log(`\nT3 POKER HARNESS — ${scenarios.length} scenario(s) against ${baseUrl}`);
  console.log('='.repeat(72));

  let failures = 0;
  const results: Array<{ name: string; ok: boolean; ms: number; hands?: number; err?: string }> = [];

  for (const s of scenarios) {
    process.stdout.write(`\n▶ ${s.name}\n  ${s.description}\n  `);
    const t0 = Date.now();
    try {
      const res = await s.run(env);
      const ms = Date.now() - t0;
      console.log(
        `PASS in ${ms}ms — gameId=${res.gameId.slice(-8)} hands=${res.handsCompleted}`
      );
      // Per-bot summary
      for (const b of res.bots) {
        const tag = b.errors.length === 0 ? '   ok' : `  ${b.errors.length}err`;
        console.log(
          `      ${tag}  ${b.cfg.email.padEnd(34)}  acts=${b.actionsTaken
            .toString()
            .padStart(3)}  reconn=${b.reconnects}`
        );
      }
      results.push({ name: s.name, ok: true, ms, hands: res.handsCompleted });
    } catch (e: any) {
      const ms = Date.now() - t0;
      console.log(`FAIL in ${ms}ms`);
      console.log(`  ${e?.stack || e?.message || e}`);
      results.push({ name: s.name, ok: false, ms, err: e?.message || String(e) });
      failures++;
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('SUMMARY');
  for (const r of results) {
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)}  ${r.ms}ms${
        r.hands != null ? `  hands=${r.hands}` : ''
      }${r.err ? `  -- ${r.err}` : ''}`
    );
  }
  console.log('='.repeat(72));
  console.log(failures === 0 ? '\nALL GREEN ✅\n' : `\n${failures} FAILED ❌\n`);

  await harnessPrisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('Harness crashed:', e);
  try { await harnessPrisma.$disconnect(); } catch { /* ignore */ }
  process.exit(2);
});
