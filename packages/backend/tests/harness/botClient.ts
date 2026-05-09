/**
 * BotClient — one fake poker player.
 *
 * Drives the REAL backend through HTTP + Socket.io, just like a browser would.
 * Used by the playtest harness; NOT a unit-test mock.
 */
import { io, Socket } from 'socket.io-client';
import type { BotStrategy, Decision } from './strategies';

export interface BotConfig {
  baseUrl: string;
  email: string;
  username: string;
  password: string;
  strategy: BotStrategy;
  /** Don't react to game state. Useful for action_timeout scenario. */
  silent?: boolean;
  /** Delay between receiving turn and acting (ms). */
  thinkMs?: number;
  /** Drop the socket after this many ms once a hand starts. */
  disconnectAfterMs?: number;
  /** Reconnect this many ms after dropping. */
  reconnectAfterMs?: number;
}

export interface GameState {
  gameId: string;
  status: string;
  pot: string;
  currentBet: string;
  amountToCall: string;
  stage: string;
  board: string[];
  isMyTurn: boolean;
  myPlayer: {
    userId: string;
    chipStack: string;
    holeCards: string[];
    position: string;
    currentStageBet: string;
  };
  opponents: Array<{
    userId: string;
    chipStack: string;
    position: string;
    currentStageBet: string;
  }>;
  smallBlind: string;
  bigBlind: string;
  activePlayerUserId: string | null;
}

export interface BotEvents {
  onState?: (state: GameState) => void;
  onShowdown?: (data: any) => void;
  onAction?: (data: any) => void;
  onError?: (err: Error) => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
}

export class BotClient {
  cfg: BotConfig;
  userId: string | null = null;
  token: string | null = null;
  refreshToken: string | null = null;
  socket: Socket | null = null;
  lastState: GameState | null = null;
  events: BotEvents = {};
  /** Set true after we send an action; cleared on next state. Prevents double-acting. */
  private actionInFlight = false;
  /** Last (handStage, activePlayerIdx, currentBet) we successfully acted on. */
  private lastActedKey: string | null = null;
  /** Set when we've intentionally dropped the socket so reconnect logic doesn't fight us. */
  private intentionalDisconnect = false;
  /** Timestamp when isMyTurn went true; used to detect stalls. */
  turnStartedAt: number | null = null;
  /** Cumulative count of actions taken. */
  actionsTaken = 0;
  /** Cumulative count of socket reconnects observed. */
  reconnects = 0;
  /** Errors collected for invariant reporting. */
  errors: string[] = [];
  /** Heartbeat watchdog timer; runs while the bot is alive. */
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** Last time we successfully refreshed state (any source). */
  private lastStateAt = 0;
  /** Stall counter for diagnostics. */
  watchdogResyncs = 0;

  constructor(cfg: BotConfig, events: BotEvents = {}) {
    this.cfg = cfg;
    this.events = events;
  }

  /**
   * Heartbeat watchdog — handles the rare case where the socket is silently
   * behind. Every 2s while the bot has a known game, if it's been > 4s since
   * we saw any state and (we believe it's our turn OR we have no state at
   * all), refetch via REST. Cheap; only re-acts when the refetch shows
   * isMyTurn=true.
   */
  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(async () => {
      try {
        if (this.cfg.silent) return;
        const state = this.lastState;
        if (!state) return;
        if (state.status !== 'in_progress') return;
        const sinceState = Date.now() - this.lastStateAt;
        // Only kick in if it's our turn AND we've been silent for a while.
        // 4s is well below the 30s auto-fold but well above normal jitter.
        if (state.isMyTurn && sinceState > 4_000) {
          this.watchdogResyncs++;
          const fresh = await this.fetchState(state.gameId);
          this.lastState = fresh;
          this.lastStateAt = Date.now();
          if (fresh.isMyTurn && this.turnStartedAt === null) this.turnStartedAt = Date.now();
          if (!fresh.isMyTurn) this.turnStartedAt = null;
          await this.maybeAct();
        }
      } catch {
        /* watchdog must never throw */
      }
    }, 2_000);
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Log in (account is pre-seeded by the orchestrator). Retries 429s. */
  async authenticate(): Promise<void> {
    const tryLogin = async () =>
      this.postJson('/api/auth/login', {
        email: this.cfg.email,
        password: this.cfg.password,
      });
    let attempt = 0;
    while (true) {
      const res = await tryLogin();
      if (res.ok) {
        const body = await res.json();
        this.userId = body.user.id;
        this.token = body.accessToken;
        this.refreshToken = body.refreshToken;
        return;
      }
      if (res.status === 429 && attempt < 12) {
        // Login limit is 10/min keyed by IP (since body may not yet be parsed
        // at hook time). Back off and retry.
        attempt++;
        const wait = 6500 + Math.floor(Math.random() * 2000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      throw new Error(`Login failed for ${this.cfg.email}: ${res.status} ${text.slice(0, 160)}`);
    }
  }

  /** Open Socket.io connection with JWT auth. */
  connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.token) return reject(new Error('Not authenticated'));
      this.socket = io(this.cfg.baseUrl, {
        auth: { token: this.token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 500,
      });
      const onConnect = () => resolve();
      const onError = (err: Error) => {
        this.errors.push(`socket connect: ${err.message}`);
        reject(err);
      };
      this.socket.once('connect', onConnect);
      this.socket.once('connect_error', onError);

      this.socket.on('disconnect', (reason) => {
        if (this.intentionalDisconnect) return;
        this.events.onDisconnect?.();
      });
      this.socket.io.on('reconnect', () => {
        this.reconnects++;
        this.events.onReconnect?.();
      });

      this.socket.on('game:state', (state: GameState) => {
        this.lastState = state;
        this.lastStateAt = Date.now();
        if (state.isMyTurn && this.turnStartedAt === null) {
          this.turnStartedAt = Date.now();
        }
        if (!state.isMyTurn) this.turnStartedAt = null;
        this.events.onState?.(state);
        if (!this.cfg.silent) this.maybeAct().catch((e) => this.errors.push(`act: ${e.message}`));
      });
      // Re-decide when a peer acts or auto-folds. The server pushes
      //   - game:action  (after a player action, with full state push)
      //   - game:updated (on auto-fold; NO state push attached)
      //   - game:new-hand / game:next-hand-countdown
      // For game:updated we MUST refetch state since no state push follows.
      const onPeerEvent = () => {
        if (this.cfg.silent || !this.lastState) return;
        const gid = this.lastState.gameId;
        this.fetchState(gid)
          .then((s) => {
            this.lastState = s;
            this.lastStateAt = Date.now();
            if (s.isMyTurn && this.turnStartedAt === null) this.turnStartedAt = Date.now();
            if (!s.isMyTurn) this.turnStartedAt = null;
            return this.maybeAct();
          })
          .catch(() => {});
      };
      this.socket.on('game:action', onPeerEvent);
      this.socket.on('game:updated', onPeerEvent);
      this.socket.on('game:new-hand', () => {
        this.lastActedKey = null;
        onPeerEvent();
      });
      // Forward to user callbacks (the listeners above already call onPeerEvent).
      this.socket.on('game:action', (a) => this.events.onAction?.(a));
      this.socket.on('game:showdown', (s) => this.events.onShowdown?.(s));
    });
  }

  /** Join the private game room over the socket. */
  joinGameRoom(gameId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('No socket'));
      this.socket.emit('join:game', gameId, (ack: { ok: boolean; code?: string; message?: string }) => {
        if (ack && ack.ok) return resolve();
        reject(new Error(`join:game rejected: ${ack?.code} ${ack?.message}`));
      });
    });
  }

  /** Pull state via REST as a fallback (e.g. after reconnect). */
  async fetchState(gameId: string): Promise<GameState> {
    const res = await this.getJson(`/api/games/${gameId}/state`);
    if (!res.ok) throw new Error(`fetchState ${res.status}`);
    const state = (await res.json()) as GameState;
    this.lastStateAt = Date.now();
    return state;
  }

  /** Decide + send action when it is our turn. Idempotent + dedupes per turn key. */
  private async maybeAct() {
    if (!this.lastState || !this.lastState.isMyTurn || this.actionInFlight) return;
    if (this.lastState.status !== 'in_progress') return;
    if (this.cfg.silent) return;

    // Dedupe: the same (stage, currentBet, my contribution) means "still my
    // same decision point" — don't double-fire.
    const key = `${this.lastState.stage}|${this.lastState.currentBet}|${this.lastState.myPlayer.currentStageBet}`;
    if (key === this.lastActedKey) return;

    this.actionInFlight = true;
    try {
      if (this.cfg.thinkMs) {
        await new Promise((r) => setTimeout(r, this.cfg.thinkMs));
      }
      // State may have moved on (someone folded, etc.). Re-check.
      if (!this.lastState.isMyTurn) {
        this.actionInFlight = false;
        return;
      }
      const decision = this.cfg.strategy.decide(this.lastState);
      const ok = await this.sendAction(this.lastState.gameId, decision);
      if (ok) {
        this.actionsTaken++;
        this.lastActedKey = key;
      } else {
        // Action errored; refetch state so the next state-push has a clean
        // baseline and we can retry on a new key if it's still our turn.
        try {
          this.lastState = await this.fetchState(this.lastState.gameId);
        } catch {
          /* ignore */
        }
      }
    } catch (e: any) {
      this.errors.push(`maybeAct: ${e?.message || e}`);
    } finally {
      this.actionInFlight = false;
    }
  }

  /** Returns true on 2xx, false on any other status (which is recoverable). */
  async sendAction(gameId: string, decision: Decision): Promise<boolean> {
    const body: any = { action: decision.action };
    if (decision.action === 'raise' && typeof decision.raiseAmount === 'number') {
      body.raiseAmount = decision.raiseAmount;
    }
    const res = await this.postJson(`/api/games/${gameId}/action`, body);
    if (res.ok) return true;
    const text = await res.text();
    // "Stale action" is expected when state was racy; not a real error.
    if (text.includes('Stale action')) return false;
    this.errors.push(
      `action ${decision.action}@${gameId.slice(-6)} -> ${res.status} ${text.slice(0, 200)}`
    );
    return false;
  }

  /** Disconnect socket (simulates a browser tab closing). */
  disconnect(intentional = true) {
    this.intentionalDisconnect = intentional;
    this.socket?.disconnect();
  }

  /** Reconnect after intentional disconnect. */
  async reconnect(gameId: string) {
    this.intentionalDisconnect = false;
    await this.connectSocket();
    await this.joinGameRoom(gameId);
    // Refresh state since we may have missed events while gone.
    try {
      this.lastState = await this.fetchState(gameId);
      if (!this.cfg.silent) await this.maybeAct();
    } catch {
      /* ignore */
    }
  }

  /** Cleanly tear down (call from orchestrator after session ends). */
  shutdown() {
    this.stopWatchdog();
    this.intentionalDisconnect = true;
    this.socket?.disconnect();
  }

  // ---------- HTTP helpers ----------

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async postJson(path: string, body: any): Promise<Response> {
    return fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
  }

  async getJson(path: string): Promise<Response> {
    return fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(false),
    });
  }
}
