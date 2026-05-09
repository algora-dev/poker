/**
 * Run logging — structured JSONL forensics for harness runs.
 *
 * Every harness run writes a single JSONL file to tests/harness/runs/
 * with one event per line. Events have stable shapes; greppable by `kind`.
 *
 * Goals:
 *   - On failure, the JSONL + the server log slice must be enough to
 *     reproduce the bug without re-running.
 *   - Cheap enough to leave on always (write append-only, no fsync per line).
 *   - One file per scenario per run; runId shared across all of them.
 */
import * as fs from 'fs';
import * as path from 'path';

export type LogEventKind =
  | 'run.start'
  | 'run.end'
  | 'scenario.start'
  | 'scenario.end'
  | 'scenario.fail'
  | 'invariant.fail'
  | 'bot.action'
  | 'bot.error'
  | 'bot.disconnect'
  | 'bot.reconnect'
  | 'bot.watchdog'
  | 'state.update'
  | 'note';

export interface LogEvent {
  ts: string;          // ISO timestamp
  runId: string;
  scenario?: string;
  kind: LogEventKind;
  /** Optional invariant id, e.g. INV-CHIPS-CONSERVED. */
  invariantId?: string;
  data?: Record<string, any>;
}

export class RunLog {
  readonly runId: string;
  readonly runDir: string;
  private currentScenario: string | null = null;
  private currentStream: fs.WriteStream | null = null;
  /** Errors collected during the current scenario; cleared on scenario start. */
  private scenarioErrors: string[] = [];

  constructor(runId?: string, baseDir?: string) {
    this.runId = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    const root = baseDir ?? path.resolve(__dirname, 'runs');
    this.runDir = path.join(root, this.runId);
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  /** Start a new scenario log file. Closes the previous one if any. */
  startScenario(name: string) {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
    this.currentScenario = name;
    this.scenarioErrors = [];
    const file = path.join(this.runDir, `${name}.jsonl`);
    this.currentStream = fs.createWriteStream(file, { flags: 'a' });
    this.write({ kind: 'scenario.start', data: { name } });
  }

  endScenario(name: string, ok: boolean, extra?: Record<string, any>) {
    this.write({
      kind: ok ? 'scenario.end' : 'scenario.fail',
      data: { name, ok, ...extra },
    });
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
    this.currentScenario = null;
  }

  /** Record an event. Cheap; sync-buffered. */
  write(ev: Omit<LogEvent, 'ts' | 'runId' | 'scenario'>) {
    const full: LogEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      scenario: this.currentScenario ?? undefined,
      ...ev,
    };
    const line = JSON.stringify(full) + '\n';
    if (this.currentStream) {
      this.currentStream.write(line);
    } else {
      // No active scenario — write to run-level file.
      fs.appendFileSync(path.join(this.runDir, '_run.jsonl'), line);
    }
    if (ev.kind === 'invariant.fail' || ev.kind === 'bot.error' || ev.kind === 'scenario.fail') {
      this.scenarioErrors.push(JSON.stringify(ev));
    }
  }

  /** Write a one-shot summary.json next to the JSONLs. */
  writeSummary(summary: any) {
    fs.writeFileSync(
      path.join(this.runDir, 'summary.json'),
      JSON.stringify(summary, null, 2)
    );
  }

  /** Append a one-line markdown row to audits/t3-poker/harness-results.md. */
  appendResultsRow(row: {
    runId: string;
    profile: string;
    scenarios: number;
    passed: number;
    failed: number;
    totalMs: number;
    notes?: string;
  }) {
    const auditPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'audits',
      't3-poker',
      'harness-results.md'
    );
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    if (!fs.existsSync(auditPath)) {
      fs.writeFileSync(
        auditPath,
        `# Harness results scoreboard\n\nAppend-only log of every harness run. Use to spot regressions over time.\n\n| runId | profile | scenarios | pass | fail | totalMs | notes |\n|---|---|---|---|---|---|---|\n`
      );
    }
    const line = `| ${row.runId} | ${row.profile} | ${row.scenarios} | ${row.passed} | ${row.failed} | ${row.totalMs} | ${row.notes ?? ''} |\n`;
    fs.appendFileSync(auditPath, line);
  }

  close() {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
  }
}

/** Process-singleton: the currently active run log (set by runHarness). */
let _activeRunLog: RunLog | null = null;
export function setActiveRunLog(log: RunLog | null) { _activeRunLog = log; }
export function getActiveRunLog(): RunLog | null { return _activeRunLog; }

/**
 * Invariant ID registry — every assertion gets a stable ID so failures
 * are greppable across runs.
 */
export const INV = {
  CHIPS_CONSERVED: 'INV-CHIPS-CONSERVED',
  NO_NEG_STACK: 'INV-NO-NEG-STACK',
  SESSION_LEDGER: 'INV-SESSION-LEDGER',
  NO_STALLS: 'INV-NO-STALLS',
  BOTS_HEALTHY: 'INV-BOTS-HEALTHY',
  CLOSED_GAMES_EMPTY: 'INV-CLOSED-GAMES-EMPTY',
  SEQ_MONOTONIC: 'INV-SEQ-MONOTONIC',
} as const;
