/**
 * Harness entry point.
 *
 * env vars:
 *   HARNESS_BASE_URL          (default http://localhost:3000)
 *   HARNESS_ADMIN_SECRET      (required to top up bot bankrolls)
 *   HARNESS_SCENARIO          (default: run all; comma-list also supported)
 *   HARNESS_RUN_SUFFIX        (default: persist1; per-run isolation if needed)
 *   HARNESS_PROFILE           (default: local; tagged on results)
 *   HARNESS_PARALLEL          (default: 1; N>1 runs that many scenarios concurrently)
 *   HARNESS_HAND_MULTIPLIER   (default: 1; multiplies maxHands per scenario)
 *   HARNESS_LOOP_MINUTES      (default: 0; loop scenarios until first fail OR N minutes)
 *   HARNESS_SKIP_RESET        (default: 0; '1' skips DB reset between scenarios)
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
  const parallelism = Math.max(1, parseInt(process.env.HARNESS_PARALLEL ?? '1', 10) || 1);
  const loopMinutes = Math.max(0, parseFloat(process.env.HARNESS_LOOP_MINUTES ?? '0') || 0);
  const handMultiplier = parseFloat(process.env.HARNESS_HAND_MULTIPLIER ?? '1') || 1;
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

  let scenarios: typeof SCENARIOS;
  if (onlyScenario) {
    const names = onlyScenario.split(',').map((s) => s.trim()).filter(Boolean);
    scenarios = names
      .map((n) => getScenario(n))
      .filter((s): s is typeof SCENARIOS[number] => Boolean(s));
    if (scenarios.length === 0) {
      console.error(`FAIL: unknown scenario(s) '${onlyScenario}'. Known: ${listScenarios().join(', ')}`);
      process.exit(2);
    }
  } else {
    scenarios = SCENARIOS;
  }

  console.log(
    `\nT3 POKER HARNESS — ${scenarios.length} scenario(s) against ${baseUrl}` +
      `\n  parallel=${parallelism}  handMultiplier=${handMultiplier}  loopMinutes=${loopMinutes}`
  );
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

  // ---- Single scenario runner (used by both serial+parallel paths) ----
  async function runOne(s: typeof scenarios[number], passLabel: string): Promise<void> {
    process.stdout.write(`\n▶ [${passLabel}] ${s.name}\n  ${s.description}\n  `);
    // Each scenario gets its own logical 'scenario' label inside the JSONL.
    // For parallel runs the singleton-runLog is shared; we tag entries with
    // the passLabel so concurrent streams stay disambiguable.
    const scenarioKey = passLabel === 'main' ? s.name : `${passLabel}_${s.name}`;
    // Per-pass bot suffix: parallel slots and loop passes need distinct bot
    // accounts so they don't collide on the User table or step on each
    // other's seats. Sanitize for email-safe characters.
    const slotEnv: ScenarioEnv = passLabel === 'main'
      ? env
      : { ...env, runSuffix: `${env.runSuffix ?? 'persist1'}_${passLabel}`.toLowerCase().replace(/[^a-z0-9_]/g, '') };
    runLog.startScenario(scenarioKey);
    const t0 = Date.now();
    // Bind subsequent writes (and any DB-snapshot lookups via the
    // inflight map) to THIS scenarioKey so parallel slots don't interleave.
    await runLog.runInScenario(scenarioKey, async () => {
      let lastResult: any = null;
      try {
        const res = await s.run(slotEnv);
        lastResult = res;
        const ms = Date.now() - t0;
        console.log(
          `[${passLabel}] PASS ${s.name} in ${ms}ms — gameId=${res.gameId.slice(-8)} hands=${res.handsCompleted}`
        );
        for (const b of res.bots) {
          const tag = b.errors.length === 0 ? '   ok' : `  ${b.errors.length}err`;
          console.log(
            `      ${tag}  ${b.cfg.email.padEnd(34)}  acts=${b.actionsTaken
              .toString()
              .padStart(3)}  reconn=${b.reconnects}  watchdog=${b.watchdogResyncs}`
          );
        }
        results.push({ name: scenarioKey, ok: true, ms, hands: res.handsCompleted });
        runLog.endScenario(scenarioKey, true, { ms, hands: res.handsCompleted, gameId: res.gameId });
      } catch (e: any) {
        const ms = Date.now() - t0;
        console.log(`[${passLabel}] FAIL ${s.name} in ${ms}ms`);
        console.log(`  ${e?.stack || e?.message || e}`);
        const invariantId = e?.invariantId;
        results.push({ name: scenarioKey, ok: false, ms, err: e?.message || String(e) });
        failures++;
        try {
          // Inflight map is keyed by runId + scenarioKey so parallel
          // slots don't read each other's gameIds (Gerald 2026-05-09).
          const inflightRoot = (globalThis as any).__harness_inflight?.[runLog.runId] ?? {};
          const inflight = inflightRoot[scenarioKey];
          const snap = await snapshotFailure({
            prisma: harnessPrisma,
            runDir: runLog.runDir,
            scenario: scenarioKey,
            gameId: lastResult?.gameId ?? inflight?.gameId,
            botUserIds: lastResult?.botUserIds ?? inflight?.botUserIds,
            errorMessage: e?.message || String(e),
            invariantId,
          });
          const issue = autoFileIssue({
            scenario: scenarioKey,
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
        runLog.endScenario(scenarioKey, false, { ms, error: e?.message, invariantId });
      }
    });
  }

  // ---- Pass dispatcher: serial (with reset) or parallel (no reset). ----
  async function runPass(passLabel: string): Promise<void> {
    if (parallelism <= 1) {
      for (const s of scenarios) {
        // Serial: reset between scenarios so each starts clean.
        if (process.env.HARNESS_SKIP_RESET !== '1') {
          try { await resetGameState(); } catch { /* non-fatal */ }
        }
        await runOne(s, passLabel);
      }
      return;
    }
    // Parallel: NO reset. Scenarios are isolated by suffixed bot accounts
    // and per-game scoped invariants. Skip the up-front cross-scenario
    // reset; rely on each scenario being self-contained.
    const queue = scenarios.slice();
    const workers: Promise<void>[] = [];
    for (let i = 0; i < parallelism; i++) {
      workers.push((async () => {
        while (queue.length) {
          const s = queue.shift();
          if (!s) break;
          // Each parallel slot uses a distinct passLabel suffix so logs are
          // unambiguous and bot suffixes don't collide.
          const slotLabel = `${passLabel}_p${i}`;
          await runOne(s, slotLabel);
        }
      })());
    }
    await Promise.all(workers);
  }

  // ---- Loop or single pass. ----
  const loopDeadline = loopMinutes > 0 ? Date.now() + loopMinutes * 60_000 : 0;
  let pass = 0;
  do {
    pass++;
    const passLabel = loopDeadline > 0 ? `loop${pass}` : 'main';
    await runPass(passLabel);
    if (loopDeadline === 0) break;
    if (failures > 0) {
      console.log(`\n[harness] loop mode: stopping after first failure on pass ${pass}`);
      break;
    }
    if (Date.now() >= loopDeadline) {
      console.log(`\n[harness] loop mode: ${loopMinutes} minutes elapsed, stopping after pass ${pass}`);
      break;
    }
  } while (true);

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
    notes: `parallel=${parallelism} handMult=${handMultiplier} loopMin=${loopMinutes} passes=${pass}`,
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
