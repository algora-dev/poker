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
 *   - PARALLEL-SAFE: each scenario keeps its own append stream so two
 *     concurrently-running scenarios don't trample each other's logs.
 *     Per Gerald's review (2026-05-09): the previous single
 *     `currentScenario`/`currentStream` was a parallelism hazard.
 */
import { AsyncLocalStorage } from 'async_hooks';
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

interface ScenarioStream {
  name: string;
  stream: fs.WriteStream;
}

/** Per-async-context current scenario name. Parallel slots get their own. */
const scenarioContext = new AsyncLocalStorage<{ scenarioKey: string }>();

export class RunLog {
  readonly runId: string;
  readonly runDir: string;
  /** Open streams keyed by scenarioKey. */
  private streams = new Map<string, ScenarioStream>();

  constructor(runId?: string, baseDir?: string) {
    this.runId = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    const root = baseDir ?? path.resolve(__dirname, 'runs');
    this.runDir = path.join(root, this.runId);
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  /**
   * Open (or reuse) the stream for `scenarioKey`. Each scenario has its
   * own append-mode WriteStream so parallel writers do not interleave.
   * The returned object lets the caller bind subsequent writes via
   * `runInScenario(...)`.
   */
  startScenario(scenarioKey: string) {
    if (!this.streams.has(scenarioKey)) {
      const file = path.join(this.runDir, `${this.safeName(scenarioKey)}.jsonl`);
      const stream = fs.createWriteStream(file, { flags: 'a' });
      this.streams.set(scenarioKey, { name: scenarioKey, stream });
    }
    this.write({ kind: 'scenario.start', data: { name: scenarioKey } }, scenarioKey);
  }

  endScenario(scenarioKey: string, ok: boolean, extra?: Record<string, any>) {
    this.write(
      { kind: ok ? 'scenario.end' : 'scenario.fail', data: { name: scenarioKey, ok, ...extra } },
      scenarioKey
    );
    const s = this.streams.get(scenarioKey);
    if (s) {
      s.stream.end();
      this.streams.delete(scenarioKey);
    }
  }

  /**
   * Run a callback with `scenarioKey` bound as the implicit scenario for
   * any `write()` calls inside it (including from descendant async work).
   */
  runInScenario<T>(scenarioKey: string, fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(scenarioContext.run({ scenarioKey }, fn as any));
  }

  /**
   * Record an event. If `scenarioKey` is provided it goes to that
   * scenario's file; otherwise the implicit context's scenarioKey is
   * used; otherwise the event is written to the run-level file.
   */
  write(ev: Omit<LogEvent, 'ts' | 'runId' | 'scenario'>, scenarioKey?: string) {
    const ctx = scenarioContext.getStore();
    const targetKey = scenarioKey ?? ctx?.scenarioKey;
    const full: LogEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      scenario: targetKey,
      ...ev,
    };
    const line = JSON.stringify(full) + '\n';
    if (targetKey) {
      const s = this.streams.get(targetKey);
      if (s) {
        s.stream.write(line);
        return;
      }
    }
    fs.appendFileSync(path.join(this.runDir, '_run.jsonl'), line);
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
    for (const s of this.streams.values()) s.stream.end();
    this.streams.clear();
  }

  /** Strip filesystem-unsafe chars for use in a filename. */
  private safeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /** Read the current implicit scenarioKey, if any. */
  static currentScenarioKey(): string | undefined {
    return scenarioContext.getStore()?.scenarioKey;
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
