/**
 * Bot-fill registry — process-local tracker for active bot sessions.
 *
 * Concurrency limits (per the bot-fill spec):
 *   - max 9 bots per /admin/spawn-bots call (further clamped by table free seats)
 *   - max 2 concurrent spawn-bot batches globally
 *   - in production, the entire feature is gated by ALLOW_BOT_FILL=1
 *
 * The registry is process-local. If the backend is horizontally scaled in
 * the future, move this into Postgres or Redis. For dev/single-instance
 * Railway, in-memory is fine.
 */
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { CONFIG } from '../../config';
import { BotSession, type BotSessionInfo } from './botSession';
import { isStrategyName, type StrategyName } from './strategies';

export const MAX_BOTS_PER_CALL = 9;
export const MAX_CONCURRENT_BATCHES = 2;
const LOG_PREFIX = '[BOT_FILL]';

/** Disabled in production unless ALLOW_BOT_FILL=1 is explicitly set. */
export function isBotFillAllowed(): boolean {
  if (CONFIG.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_BOT_FILL === '1';
}

interface RegistryEntry {
  session: BotSession;
  batchId: string;
}

const sessions = new Map<string, RegistryEntry>();
const batches = new Set<string>();

export interface SpawnRequest {
  gameId: string;
  count: number;
  strategy?: StrategyName;
  baseUrl: string;
  buyInChips: number;
  bankrollChips: number;
  adminSecret: string;
  thinkMs?: number;
}

export interface SpawnResult {
  batchId: string;
  spawned: BotSessionInfo[];
}

export class BotFillError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Validate and normalize a spawn request. Throws BotFillError on bad input. */
export function validateSpawnRequest(input: unknown): SpawnRequest {
  if (!input || typeof input !== 'object') {
    throw new BotFillError('invalid_body', 'request body required');
  }
  const obj = input as Record<string, unknown>;
  const gameId = obj.gameId;
  const count = obj.count;
  const strategy = obj.strategy ?? 'random';
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw new BotFillError('invalid_game_id', 'gameId required');
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    throw new BotFillError('invalid_count', 'count must be a positive integer');
  }
  if (count > MAX_BOTS_PER_CALL) {
    throw new BotFillError(
      'too_many_bots',
      `count cannot exceed ${MAX_BOTS_PER_CALL} per call`
    );
  }
  if (!isStrategyName(strategy)) {
    throw new BotFillError(
      'invalid_strategy',
      'strategy must be one of: random, tight, loose'
    );
  }
  return {
    gameId,
    count,
    strategy,
    // Filled by the caller (route handler); the validator just forwards them.
    baseUrl: '',
    buyInChips: 0,
    bankrollChips: 0,
    adminSecret: '',
  };
}

/**
 * Spawn a batch of bots into a game. Resolves once every bot has either
 * fully joined (HTTP + socket + room) OR errored. On any failure, every
 * bot already-spawned in this batch is shut down so we don't leak seats.
 */
export async function spawnBots(req: SpawnRequest): Promise<SpawnResult> {
  if (!isBotFillAllowed()) {
    throw new BotFillError(
      'bot_fill_disabled',
      'Bot-fill is disabled in this environment (set ALLOW_BOT_FILL=1 to enable)',
      403
    );
  }
  if (batches.size >= MAX_CONCURRENT_BATCHES) {
    throw new BotFillError(
      'too_many_batches',
      `at most ${MAX_CONCURRENT_BATCHES} concurrent bot-fill batches allowed`,
      429
    );
  }

  const batchId = randomUUID();
  batches.add(batchId);
  const spawned: BotSession[] = [];

  try {
    for (let i = 0; i < req.count; i++) {
      const sessionId = randomUUID();
      const session = new BotSession({
        baseUrl: req.baseUrl,
        gameId: req.gameId,
        buyInChips: req.buyInChips,
        bankrollChips: req.bankrollChips,
        strategy: req.strategy ?? 'random',
        adminSecret: req.adminSecret,
        thinkMs: req.thinkMs,
        sessionId,
      });
      // Sequential so we honour per-user money mutex / table fill order
      // and surface "table full" cleanly mid-batch.
      await session.start();
      sessions.set(sessionId, { session, batchId });
      spawned.push(session);
      // Auto-cleanup when the bot ends naturally (game completed/cancelled).
      session.endedPromise.then(() => {
        sessions.delete(sessionId);
      }).catch(() => { /* ignore */ });
    }
    logger.info(`${LOG_PREFIX} batch spawned`, {
      batchId,
      gameId: req.gameId,
      count: req.count,
      strategy: req.strategy,
    });
    return {
      batchId,
      spawned: spawned.map((s) => s.info()),
    };
  } catch (err) {
    // Roll back this batch on any failure.
    for (const s of spawned) {
      try { s.shutdown('spawn_failed'); } catch { /* ignore */ }
      sessions.delete(s.cfg.sessionId);
    }
    throw err;
  } finally {
    batches.delete(batchId);
  }
}

/** Kill all bots seated at a game. Returns the count terminated. */
export function killBotsAtGame(gameId: string): number {
  let killed = 0;
  for (const [id, { session }] of sessions) {
    if (session.cfg.gameId === gameId) {
      try { session.shutdown('admin_kill'); } catch { /* ignore */ }
      sessions.delete(id);
      killed++;
    }
  }
  if (killed > 0) {
    logger.info(`${LOG_PREFIX} killed bots at game`, { gameId, killed });
  }
  return killed;
}

/** Kill ALL active bot sessions (used on SIGTERM). */
export function killAllBots(reason = 'shutdown'): number {
  let killed = 0;
  for (const [id, { session }] of sessions) {
    try { session.shutdown(reason); } catch { /* ignore */ }
    sessions.delete(id);
    killed++;
  }
  if (killed > 0) {
    logger.info(`${LOG_PREFIX} killed all bots`, { reason, killed });
  }
  return killed;
}

/** Snapshot of every active session (for GET /admin/bots). */
export function listBots(): BotSessionInfo[] {
  return Array.from(sessions.values()).map(({ session }) => session.info());
}

/** TEST-ONLY: clear in-memory state without touching real bot sockets. */
export function _resetForTests(): void {
  sessions.clear();
  batches.clear();
}
