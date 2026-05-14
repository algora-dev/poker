/**
 * BotSession — one headless bot driven IN-PROCESS by the backend.
 *
 * Talks to its own backend over loopback HTTP + Socket.io, exactly like a
 * browser would. This means every bot action goes through the SAME
 * authoritative pipeline as a real user (joinGame, processAction, money
 * mutex, active-game lock). No DB-bypassing shortcuts.
 *
 * Lifecycle:
 *   1. ensureBotUser() — find/create the User row + ChipBalance.
 *   2. topUpBankroll() — admin-credit to a fixed dev bankroll.
 *   3. mintToken()    — sign a short-lived JWT with the same secret the
 *      socket auth verifier uses (CONFIG.JWT_SECRET).
 *   4. joinGame()     — POST /api/games/:id/join with our own bearer.
 *   5. connectSocket()/joinRoom() — subscribe to game state pushes.
 *   6. on every state push where isMyTurn=true, decide() and act() via
 *      POST /api/games/:id/action.
 *
 * Bots auto-tear-down when:
 *   - the game completes/cancels (state.status flips)
 *   - shutdown() is called (registry kill, SIGTERM)
 */
import bcrypt from 'bcrypt';
import { createSigner } from 'fast-jwt';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '../../db/client';
import { CONFIG } from '../../config';
import { logger } from '../../utils/logger';
import type { BotGameState, Decision } from './types';
import { decideForStrategy, type StrategyName } from './strategies';

const LOG_PREFIX = '[BOT_FILL]';

/** Fixed password for bot accounts — never used for login (we mint JWTs). */
const BOT_PASSWORD_PLACEHOLDER = '__bot_fill_no_login__';

export interface BotSessionConfig {
  baseUrl: string;
  gameId: string;
  buyInChips: number;
  bankrollChips: number;
  strategy: StrategyName;
  /** Admin secret used to top up bankroll via /api/admin/add-chips. */
  adminSecret: string;
  /**
   * Optional artificial think-time in ms before each action.
   *
   * History:
   *   - 300ms (initial): sluggish-feeling but masked by server latency
   *   - 100ms (2026-05-11): reduced after first speed playtest
   *   - 1500ms (2026-05-12): bumped to soften too-fast bot actions
   *   - 0ms (2026-05-13): Shaun reported the 1.5s caused inconsistent
   *     UX - sometimes instant, sometimes piled up so 3 bots fired in
   *     a burst after a 4-5s pause. Suspected: socket back-pressure or
   *     queueing interacted badly with the artificial delay. Removed
   *     entirely; rely on real network/server latency for rhythm.
   *
   * Caller may override via /api/admin/spawn-bots `thinkMs` field.
   */
  thinkMs?: number;
  /** ID used by the registry for kill/list operations. */
  sessionId: string;
}

export interface BotSessionInfo {
  sessionId: string;
  gameId: string;
  userId: string;
  username: string;
  strategy: StrategyName;
  status: 'starting' | 'active' | 'shutting_down' | 'ended';
  startedAt: number;
  actionsTaken: number;
}

export class BotSession {
  readonly cfg: BotSessionConfig;
  private signer = createSigner({ key: CONFIG.JWT_SECRET, expiresIn: 60 * 60 * 1000 });

  userId: string | null = null;
  username: string | null = null;
  token: string | null = null;
  socket: Socket | null = null;
  lastState: BotGameState | null = null;
  status: BotSessionInfo['status'] = 'starting';
  actionsTaken = 0;
  startedAt = Date.now();
  /** Set true once we send an action; cleared on next state push. */
  private actionInFlight = false;
  /** Dedupe key per turn so two state pushes don't double-fire. */
  private lastActedKey: string | null = null;
  /** True once shutdown() is called; suppresses reconnect. */
  private shuttingDown = false;
  /** Coalesce in-flight peer-triggered state refetches. */
  private peerRefetchInFlight = false;

  /**
   * Self-heal poll interval handle.
   *
   * 2026-05-14 (Shaun playtest): bots occasionally stalled until the 17s
   * turn-timer auto-folded them. Root cause is most likely a missed
   * `game:state` socket push (rare but possible under load). Without
   * the push, `maybeAct()` is never invoked and the bot sits forever.
   * This periodic re-fetch catches that case so missed pushes self-heal
   * within `SELF_HEAL_INTERVAL_MS` instead of waiting for the timer.
   */
  private selfHealTimer: ReturnType<typeof setInterval> | null = null;

  /** Minimum gap between self-heal refetches in ms. */
  private static readonly SELF_HEAL_INTERVAL_MS = 5_000;
  /** Skip self-heal if a recent fetch already happened within this window. */
  private static readonly SELF_HEAL_MIN_AGE_MS = 3_000;
  /** Last successful state-fetch timestamp; used to throttle peer pulls. */
  private lastStateFetchAt = 0;
  /** Minimum ms between peer-triggered state pulls. */
  private static readonly PEER_REFETCH_MIN_MS = 250;
  /** Resolves when the game ends naturally so spawn() callers can await it. */
  private endedResolver: (() => void) | null = null;
  endedPromise: Promise<void>;

  constructor(cfg: BotSessionConfig) {
    this.cfg = cfg;
    this.endedPromise = new Promise<void>((resolve) => {
      this.endedResolver = resolve;
    });
  }

  info(): BotSessionInfo {
    return {
      sessionId: this.cfg.sessionId,
      gameId: this.cfg.gameId,
      userId: this.userId ?? '',
      username: this.username ?? '',
      strategy: this.cfg.strategy,
      status: this.status,
      startedAt: this.startedAt,
      actionsTaken: this.actionsTaken,
    };
  }

  /** Full bring-up: user → bankroll → join → socket → race the game. */
  async start(): Promise<void> {
    await this.ensureBotUser();
    await this.topUpBankroll();
    this.token = this.signer({ userId: this.userId! });
    await this.joinGame();
    await this.connectSocket();
    await this.joinRoom();
    this.status = 'active';
    logger.info(`${LOG_PREFIX} session active`, {
      sessionId: this.cfg.sessionId,
      userId: this.userId,
      username: this.username,
      gameId: this.cfg.gameId,
      strategy: this.cfg.strategy,
    });
    // Kick a one-time state pull so we can act immediately if it's already
    // our turn (e.g. blinds posted and we're SB).
    try {
      const s = await this.fetchState();
      this.lastState = s;
      void this.maybeAct();
    } catch {
      /* socket pushes will catch up */
    }
    // Self-heal poll: catches missed socket pushes that would otherwise
    // leave the bot stalled until the 17s human turn-timer fires.
    this.selfHealTimer = setInterval(() => { void this.selfHealTick(); }, BotSession.SELF_HEAL_INTERVAL_MS);
  }

  /**
   * Cheap periodic check: if we haven't fetched state in a while and the
   * cached state says it's our turn, re-fetch and try to act. Quietly
   * does nothing if we're in flight, recently fetched, or it's plainly
   * not our turn.
   */
  private async selfHealTick(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.actionInFlight) return;
    if (this.peerRefetchInFlight) return;
    const age = Date.now() - this.lastStateFetchAt;
    if (age < BotSession.SELF_HEAL_MIN_AGE_MS) return;
    // No isMyTurn fast-path here: the whole point of this tick is to
    // catch missed socket pushes where lastState is stale and says
    // it's NOT our turn even though it is. We always re-fetch when the
    // cached state is older than SELF_HEAL_MIN_AGE_MS.
    try {
      const s = await this.fetchState();
      this.lastState = s;
      this.lastStateFetchAt = Date.now();
      this.handleStatePush(s);
      await this.maybeAct();
    } catch {
      /* ignore — next tick retries */
    }
  }

  /** Tear down the socket and mark ended. Idempotent. */
  shutdown(reason: string = 'manual'): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.status = 'shutting_down';
    if (this.selfHealTimer) {
      clearInterval(this.selfHealTimer);
      this.selfHealTimer = null;
    }
    try {
      this.socket?.disconnect();
    } catch { /* ignore */ }
    this.socket = null;
    this.status = 'ended';
    this.endedResolver?.();
    logger.info(`${LOG_PREFIX} session ended`, {
      sessionId: this.cfg.sessionId,
      userId: this.userId,
      gameId: this.cfg.gameId,
      reason,
      actionsTaken: this.actionsTaken,
    });
  }

  // ------------------------------------------------------------------
  //  Bot user provisioning
  // ------------------------------------------------------------------

  private async ensureBotUser(): Promise<void> {
    const username = `bot_${this.cfg.sessionId.replace(/-/g, '').slice(0, 16)}`;
    const email = `${username}@bots.local`;
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(BOT_PASSWORD_PLACEHOLDER, 10);
      user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email,
            username,
            passwordHash,
          },
        });
        await tx.chipBalance.create({ data: { userId: u.id, chips: 0n } });
        return u;
      });
    }
    this.userId = user.id;
    this.username = user.username;
  }

  /**
   * Top up the bot's chip bankroll via the admin endpoint so we go through
   * the audited credit path. Tags the audit row clearly as BOT_FILL.
   */
  private async topUpBankroll(): Promise<void> {
    const target = BigInt(Math.floor(this.cfg.bankrollChips * 1_000_000));
    const bal = await prisma.chipBalance.findUnique({ where: { userId: this.userId! } });
    const cur = bal?.chips ?? 0n;
    if (cur >= target) return;
    const need = target - cur;
    const needChips = Number(need) / 1_000_000;
    // Use the existing admin add-chips endpoint so we reuse its audit path.
    // It writes a ChipAudit row tagged 'admin_adjustment' with notes — we
    // append the BOT_FILL marker so audit queries can split it out cleanly.
    const res = await fetch(`${this.cfg.baseUrl}/api/admin/add-chips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: this.cfg.adminSecret,
        // Bot accounts use deterministic email: bot_<id>@bots.local
        email: `${this.username}@bots.local`,
        amount: needChips,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `${LOG_PREFIX} bankroll top-up failed for ${this.username}: ${res.status} ${text.slice(0, 160)}`
      );
    }
  }

  private async joinGame(): Promise<void> {
    const res = await this.postJson(`/api/games/${this.cfg.gameId}/join`, {
      buyInAmount: this.cfg.buyInChips,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `${LOG_PREFIX} join failed (${this.username} -> ${this.cfg.gameId}): ${res.status} ${text.slice(0, 200)}`
      );
    }
  }

  // ------------------------------------------------------------------
  //  Socket pipeline
  // ------------------------------------------------------------------

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.token) return reject(new Error(`${LOG_PREFIX} no token`));
      this.socket = ioClient(this.cfg.baseUrl, {
        auth: { token: this.token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 500,
      });
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', (err: Error) => {
        if (this.shuttingDown) return;
        reject(new Error(`${LOG_PREFIX} socket connect error: ${err.message}`));
      });

      this.socket.on('disconnect', () => {
        if (this.shuttingDown) return;
        // Auto-reconnect handled by socket.io; nothing to do.
      });

      this.socket.on('game:state', (state: BotGameState) => {
        this.lastState = state;
        this.handleStatePush(state);
        void this.maybeAct();
      });

      // Peer events without a state attached: refetch on next tick,
      // but coalesce bursts (multiple peers acting in the same window
      // would otherwise trigger an N^2 refetch storm).
      const onPeer = () => {
        if (this.shuttingDown) return;
        if (this.peerRefetchInFlight) return;
        const now = Date.now();
        if (now - this.lastStateFetchAt < BotSession.PEER_REFETCH_MIN_MS) return;
        this.peerRefetchInFlight = true;
        this.fetchState()
          .then((s) => {
            this.lastState = s;
            this.lastStateFetchAt = Date.now();
            this.handleStatePush(s);
            return this.maybeAct();
          })
          .catch(() => { /* ignore */ })
          .finally(() => {
            this.peerRefetchInFlight = false;
          });
      };
      this.socket.on('game:action', onPeer);
      this.socket.on('game:updated', onPeer);
      this.socket.on('game:new-hand', () => {
        this.lastActedKey = null;
        onPeer();
      });
    });
  }

  private joinRoom(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error(`${LOG_PREFIX} no socket`));
      this.socket.emit(
        'join:game',
        this.cfg.gameId,
        (ack: { ok: boolean; code?: string; message?: string }) => {
          if (ack && ack.ok) return resolve();
          reject(
            new Error(
              `${LOG_PREFIX} join:game rejected (${ack?.code}): ${ack?.message}`
            )
          );
        }
      );
    });
  }

  private handleStatePush(state: BotGameState): void {
    if (state.status === 'completed' || state.status === 'cancelled') {
      this.shutdown(`game_${state.status}`);
    }
  }

  /**
   * Is it actually our turn to act, given a fresh state? Server-side guards
   * (Not your turn, No active hand, Stale action, hand stage=completed) all
   * map to "do nothing" here so we never spam the server.
   */
  private isActionable(state: BotGameState | null): state is BotGameState {
    if (!state) return false;
    if (state.status !== 'in_progress') return false;
    if (!state.isMyTurn) return false;
    if (state.activePlayerUserId && state.activePlayerUserId !== this.userId) return false;
    // Hand-level guards: skip when the hand is between rounds (server is
    // handling deal/showdown) or already completed.
    const stage = state.stage?.toLowerCase?.() ?? '';
    if (stage === 'completed' || stage === 'showdown' || stage === '') return false;
    return true;
  }

  // ------------------------------------------------------------------
  //  Decide + act
  // ------------------------------------------------------------------

  private async maybeAct(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.actionInFlight) return;
    if (!this.isActionable(this.lastState)) return;

    const s = this.lastState;
    const key = `${s.stage}|${s.currentBet}|${s.myPlayer.currentStageBet}|${s.amountToCall}`;
    if (key === this.lastActedKey) return;

    this.actionInFlight = true;
    try {
      // Playtest 2026-05-13: removed artificial think-time (was 1500ms).
      // Bots act as fast as the server allows; humans get a 17s turn timer.
      const thinkMs = this.cfg.thinkMs ?? 0;
      if (thinkMs > 0) await sleep(thinkMs);
      if (this.shuttingDown) return;

      // CRITICAL: refetch authoritative state immediately before acting.
      // The cached state may be stale by hundreds of ms because of the
      // think-delay above plus socket lag; acting on a stale cache is the
      // "Cannot check - you need to call X" / "Raise must be higher" /
      // stale-action error class we saw in production.
      let fresh: BotGameState;
      try {
        fresh = await this.fetchState();
        this.lastState = fresh;
        this.lastStateFetchAt = Date.now();
      } catch {
        return; // network blip — next state push will retry.
      }
      if (!this.isActionable(fresh)) return;

      // Re-derive the dedupe key against the fresh state so a stale-state
      // dedupe never blocks a legitimate new turn.
      const freshKey = `${fresh.stage}|${fresh.currentBet}|${fresh.myPlayer.currentStageBet}|${fresh.amountToCall}`;
      if (freshKey === this.lastActedKey) return;

      const decision = decideForStrategy(this.cfg.strategy, fresh);
      // Final-mile legality: if owe>0 and we somehow chose check, downgrade
      // to call. Belt-and-braces — strategy already enforces this.
      const owe = BigInt(fresh.amountToCall);
      if (decision.action === 'check' && owe > 0n) {
        decision.action = 'call';
      }
      const ok = await this.sendAction(decision);
      if (ok) {
        this.actionsTaken++;
        this.lastActedKey = freshKey;
      }
    } catch (err: any) {
      logger.warn(`${LOG_PREFIX} action loop error`, {
        sessionId: this.cfg.sessionId,
        error: err?.message,
      });
    } finally {
      this.actionInFlight = false;
    }
  }

  private async sendAction(decision: Decision): Promise<boolean> {
    const body: Record<string, unknown> = { action: decision.action };
    if (decision.action === 'raise' && typeof decision.raiseAmount === 'number') {
      body.raiseAmount = decision.raiseAmount;
    }
    const res = await this.postJson(`/api/games/${this.cfg.gameId}/action`, body);
    if (res.ok) return true;
    const text = await res.text();
    const lc = text.toLowerCase();
    // Soft-retry on any "transient" engine error — these all mean "the
    // server's view of the table moved since our cached state; back off and
    // wait for the next state push". Matched case-insensitively because
    // server messages mix "Not your turn" / "not your turn".
    if (
      lc.includes('stale action') ||
      lc.includes('raise must be higher than current bet') ||
      lc.includes('raise must be at least') ||
      lc.includes('not your turn') ||
      lc.includes('no active hand') ||
      lc.includes('cannot check') ||
      lc.includes('player not active')
    ) {
      return false;
    }
    if (res.status === 429) {
      await sleep(1000);
      return false;
    }
    logger.warn(`${LOG_PREFIX} action rejected`, {
      sessionId: this.cfg.sessionId,
      action: decision.action,
      status: res.status,
      body: text.slice(0, 200),
    });
    return false;
  }

  private async fetchState(): Promise<BotGameState> {
    const res = await this.getJson(`/api/games/${this.cfg.gameId}/state`);
    if (!res.ok) throw new Error(`fetchState ${res.status}`);
    return (await res.json()) as BotGameState;
  }

  // ------------------------------------------------------------------
  //  HTTP helpers (private — bots only ever call their own backend)
  // ------------------------------------------------------------------

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
  }

  private getJson(path: string): Promise<Response> {
    return fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(false),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
