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
import { RunLog, setActiveRunLog } from './runLog';
import { autoFileIssue, snapshotFailure } from './dbSnapshot';

/**
 * Phase 10: ensure each scenario starts from a known-clean game state.
 * Wipes only game-related rows, leaves users + chip balances intact (those
 * are repopulated/topped-up by the orchestrator each run).
 */
async function resetGameState() {
  // Order matters — truncate child tables first to avoid FK violations.
  // We use deleteMany so Prisma stays in sync with the row counts.
  await harnessPrisma.handAction.deleteMany({});
  await harnessPrisma.handEvent.deleteMany({});
  await harnessPrisma.moneyEvent.deleteMany({});
  await harnessPrisma.sidePot.deleteMany({});
  await harnessPrisma.hand.deleteMany({});
  await harnessPrisma.gamePlayer.deleteMany({});
  await harnessPrisma.game.deleteMany({});
  await harnessPrisma.chipAudit.deleteMany({});
  await harnessPrisma.chipBalance.updateMany({ data: { chips: 0n } });
}

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

  const profile = process.env.HARNESS_PROFILE ?? 'local';
  const runLog = new RunLog();
  setActiveRunLog(runLog);
  runLog.write({ kind: 'run.start', data: { baseUrl, profile, runSuffix } });
  console.log(`[harness] runId=${runLog.runId}  profile=${profile}  runDir=${runLog.runDir}`);

  const env: ScenarioEnv = { baseUrl, adminSecret, runSuffix, runLog };

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

  // Phase 10: reset to a clean DB before the first scenario so leftover
  // games from prior runs cannot inflate the ledger total.
  if (process.env.HARNESS_SKIP_RESET !== '1') {
    try {
      await resetGameState();
      console.log('[harness] DB reset to clean game state');
    } catch (e: any) {
      console.error(`[harness] DB reset failed: ${e.message}`);
      process.exit(2);
    }
  }

  for (const s of scenarios) {
    // Reset between scenarios too so each one starts from a clean slate
    // and inter-scenario state coupling cannot inflate the ledger.
    if (process.env.HARNESS_SKIP_RESET !== '1') {
      try {
        await resetGameState();
      } catch {
        /* non-fatal between scenarios */
      }
    }
    process.stdout.write(`\n▶ ${s.name}\n  ${s.description}\n  `);
    runLog.startScenario(s.name);
    const t0 = Date.now();
    let lastResult: any = null;
    try {
      const res = await s.run(env);
      lastResult = res;
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
            .padStart(3)}  reconn=${b.reconnects}  watchdog=${b.watchdogResyncs}`
        );
      }
      results.push({ name: s.name, ok: true, ms, hands: res.handsCompleted });
      runLog.endScenario(s.name, true, { ms, hands: res.handsCompleted, gameId: res.gameId });
    } catch (e: any) {
      const ms = Date.now() - t0;
      console.log(`FAIL in ${ms}ms`);
      console.log(`  ${e?.stack || e?.message || e}`);
      const invariantId = e?.invariantId;
      results.push({ name: s.name, ok: false, ms, err: e?.message || String(e) });
      failures++;
      // Snapshot DB state for forensics.
      try {
        const snap = await snapshotFailure({
          prisma: harnessPrisma,
          runDir: runLog.runDir,
          scenario: s.name,
          gameId: lastResult?.gameId,
          botUserIds: lastResult?.botUserIds,
          errorMessage: e?.message || String(e),
          invariantId,
        });
        const issue = autoFileIssue({
          scenario: s.name,
          runId: runLog.runId,
          runDir: runLog.runDir,
          errorMessage: e?.message || String(e),
          invariantId,
          snapshotPath: snap,
        });
        console.log(`  [snapshot] ${snap}`);
        console.log(`  [issue]    ${issue}`);
      } catch (snapErr: any) {
        console.log(`  [snapshot] FAILED: ${snapErr?.message}`);
      }
      runLog.endScenario(s.name, false, { ms, error: e?.message, invariantId });
    }
  }

  const totalMs = results.reduce((a, r) => a + r.ms, 0);
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

  runLog.write({ kind: 'run.end', data: { failures, totalMs, results } });
  runLog.writeSummary({
    runId: runLog.runId,
    profile,
    baseUrl,
    failures,
    totalMs,
    results,
  });
  runLog.appendResultsRow({
    runId: runLog.runId,
    profile,
    scenarios: results.length,
    passed: results.length - failures,
    failed: failures,
    totalMs,
  });
  runLog.close();

  await harnessPrisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('Harness crashed:', e);
  try { await harnessPrisma.$disconnect(); } catch { /* ignore */ }
  process.exit(2);
});
