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
  /** Optional artificial think-time in ms before each action (default 300ms). */
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
  }

  /** Tear down the socket and mark ended. Idempotent. */
  shutdown(reason: string = 'manual'): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.status = 'shutting_down';
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

      // Peer events without a state attached: refetch on next tick.
      const onPeer = () => {
        if (this.shuttingDown) return;
        this.fetchState()
          .then((s) => {
            this.lastState = s;
            this.handleStatePush(s);
            return this.maybeAct();
          })
          .catch(() => { /* ignore */ });
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

  // ------------------------------------------------------------------
  //  Decide + act
  // ------------------------------------------------------------------

  private async maybeAct(): Promise<void> {
    if (this.shuttingDown) return;
    const s = this.lastState;
    if (!s || !s.isMyTurn || this.actionInFlight) return;
    if (s.status !== 'in_progress') return;

    const key = `${s.stage}|${s.currentBet}|${s.myPlayer.currentStageBet}`;
    if (key === this.lastActedKey) return;

    this.actionInFlight = true;
    try {
      const thinkMs = this.cfg.thinkMs ?? 300;
      if (thinkMs > 0) await sleep(thinkMs);
      // Re-check after the think delay — state may have moved.
      if (this.shuttingDown) return;
      if (!this.lastState || !this.lastState.isMyTurn) return;

      const decision = decideForStrategy(this.cfg.strategy, this.lastState);
      const ok = await this.sendAction(decision);
      if (ok) {
        this.actionsTaken++;
        this.lastActedKey = key;
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
    // Soft-retry on these — next state push will give a fresh decision key.
    if (
      text.includes('Stale action') ||
      text.includes('Raise must be higher than current bet') ||
      text.includes('not your turn') ||
      text.includes('Player not active')
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
