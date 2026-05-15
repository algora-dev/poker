import { Server as SocketServer, Socket } from 'socket.io';
import { createVerifier } from 'fast-jwt';
import { CONFIG } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../db/client';

// Use fast-jwt (already a transitive dependency via @fastify/jwt) to verify
// tokens with the SAME secret as the HTTP API. Tokens carry { userId }.
const verifyJwt = createVerifier({ key: CONFIG.JWT_SECRET });

let io: SocketServer | null = null;

// Track authenticated user id per socket so other modules can use it.
declare module 'socket.io' {
  interface Socket {
    userId?: string;
  }
}

/**
 * Verify a socket-handshake JWT and decide whether the bearer is
 * authorised to open a socket connection.
 *
 * SECURITY [audit-31 H-01 / audit-32]:
 * Sockets carry private game-state pushes (hole cards via the
 * per-user room, action streams via the game room). Only access
 * tokens may open a socket. Refresh tokens, legacy no-claim tokens,
 * and anything with the wrong tokenType are rejected with a
 * distinctive `reason` code so the test layer can assert which
 * branch fired without parsing log strings.
 *
 * Exported for unit testing. The runtime `io.use` middleware below
 * calls this and wraps the result in a `next(Error)` for socket.io.
 */
export function verifySocketToken(token: string): {
  ok: true;
  userId: string;
} | {
  ok: false;
  reason: 'invalid_payload' | 'wrong_token_type' | 'invalid_or_expired';
} {
  try {
    const payload = verifyJwt(token) as {
      userId?: string;
      tokenType?: 'access' | 'refresh';
    };
    if (!payload?.userId) {
      return { ok: false, reason: 'invalid_payload' };
    }
    if (payload.tokenType !== 'access') {
      return { ok: false, reason: 'wrong_token_type' };
    }
    return { ok: true, userId: payload.userId };
  } catch {
    return { ok: false, reason: 'invalid_or_expired' };
  }
}

function extractToken(socket: Socket): string | null {
  // Preferred: socket.io auth handshake
  const authToken = (socket.handshake.auth as any)?.token;
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;

  // Fallback: query string ?token=...
  const queryToken = socket.handshake.query?.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken;

  // Fallback: Authorization: Bearer <token>
  const authHeader = socket.handshake.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
}

/**
 * Initialize Socket.io server
 */
export function initializeSocketServer(server: any) {
  // CORS: same allowlist semantics as the HTTP API. Entries starting with
  // '*.' act as suffix matches (covers Vercel preview URLs).
  const allowedOrigins = CONFIG.CORS_ORIGINS
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const isProd = CONFIG.NODE_ENV === 'production';
  const isAllowedOrigin = (origin: string): boolean => {
    for (const entry of allowedOrigins) {
      if (entry === origin) return true;
      if (entry.startsWith('*.')) {
        const suffix = entry.slice(1);
        try {
          const host = new URL(origin).host;
          if (host.endsWith(suffix.slice(1)) || host === suffix.slice(2)) return true;
        } catch { /* malformed origin -> reject */ }
      }
    }
    return false;
  };
  io = new SocketServer(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.length === 0) return cb(null, !isProd);
        if (isAllowedOrigin(origin)) return cb(null, true);
        return cb(new Error('CORS rejected'), false);
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // Auth middleware: every connection must present a valid JWT.
  // The verified userId is bound to the socket and is the ONLY identity
  // we trust for room joins (clients can no longer self-claim a userId).
  //
  // SECURITY [audit-31 H-01, Gerald-flagged 2026-05-15]: sockets now
  // REQUIRE `tokenType === 'access'`. Refresh tokens cannot open a
  // socket. Legacy no-claim tokens are also rejected for clean
  // pre-production migration — clients re-login to acquire a tokenType-
  // tagged access token.
  io.use((socket, next) => {
    const token = extractToken(socket);
    if (!token) {
      logger.warn('Socket auth rejected: no token', { socketId: socket.id });
      return next(new Error('Unauthorized: missing token'));
    }
    const verdict = verifySocketToken(token);
    if (verdict.ok === true) {
      socket.userId = verdict.userId;
      return next();
    }
    // Map the verdict reason to a stable error message + log line.
    switch (verdict.reason) {
      case 'invalid_payload':
        logger.warn('Socket auth rejected: invalid token payload', {
          socketId: socket.id,
        });
        return next(new Error('Unauthorized: invalid token payload'));
      case 'wrong_token_type':
        logger.warn('Socket auth rejected: wrong token type', {
          socketId: socket.id,
        });
        return next(
          new Error('Unauthorized: socket auth requires an access token')
        );
      case 'invalid_or_expired':
      default:
        logger.warn('Socket auth rejected: bad token', { socketId: socket.id });
        return next(new Error('Unauthorized: invalid or expired token'));
    }
  });

  // Handle connections
  io.on('connection', (socket) => {
    const userId = socket.userId!;
    logger.info('Client connected', { socketId: socket.id, userId });

    // Always auto-join the authenticated user's private room.
    // Clients can no longer choose which user room they sit in.
    socket.join(`user:${userId}`);

    // Kept for backward compatibility, but the supplied userId is IGNORED.
    // We always use the authenticated socket.userId.
    socket.on('join:user', () => {
      socket.join(`user:${userId}`);
      logger.info('User re-joined own room', { userId, socketId: socket.id });
    });

    // Join game room.
    // PHASE 4 [H-03]: only seated GamePlayer rows for this game may join the
    // private game room. Non-participants must not subscribe to private hand
    // events (hole cards, action streams) or be able to spy on tables.
    // See audits/t3-poker/06-dave-fix-prompt.md Phase 4.
    //
    // SECURITY [audit-30 M-02, Gerald-flagged 2026-05-15]: per-socket
    // throttle + log coalescing. An authenticated attacker can spam
    // invalid join:game requests, forcing the server to write a
    // socket:join_rejected AppLog row per attempt. That doesn't steal
    // chips but it amplifies DB/log volume cheaply. We:
    //   1. Cap join attempts at 10/socket/60s. Above that, silently
    //      reject (no log write, no ack-with-code) for the rest of
    //      the window. Honest reconnects never hit 10/min.
    //   2. Coalesce rejected-join AppLog rows: at most one rejection
    //      row per (socket, gameId) per 60s. Repeated rejections to
    //      the same room are dropped from the log.
    const joinAttempts: number[] = [];
    const recentRejectedJoins = new Map<string, number>(); // gameId -> last log ts
    const JOIN_ATTEMPT_WINDOW_MS = 60_000;
    const JOIN_ATTEMPT_LIMIT = 10;
    const JOIN_REJECT_LOG_DEDUPE_MS = 60_000;

    socket.on('join:game', async (gameId: string, ack?: (resp: any) => void) => {
      const respond = (ok: boolean, code?: string, message?: string) => {
        if (typeof ack === 'function') {
          try { ack({ ok, code, message }); } catch { /* ignore ack errors */ }
        }
      };

      // Spam throttle.
      const now = Date.now();
      const cutoff = now - JOIN_ATTEMPT_WINDOW_MS;
      while (joinAttempts.length && joinAttempts[0] < cutoff) joinAttempts.shift();
      joinAttempts.push(now);
      if (joinAttempts.length > JOIN_ATTEMPT_LIMIT) {
        // Silent reject. No AppLog row. Honest clients never hit this.
        return respond(false, 'rate_limited', 'Too many join attempts');
      }

      const verdict = await checkGameRoomJoin(prisma, userId, gameId);
      if (verdict.ok === true) {
        socket.join(`game:${gameId}`);
        logger.info('Player joined game room', { gameId, socketId: socket.id, userId });
        // Clear rejected-coalesce state for this room since we just
        // successfully joined.
        recentRejectedJoins.delete(gameId);
        // DIAGNOSTIC (2026-05-13): persist join outcomes so we can confirm,
        // after the fact, which sockets actually subscribed to a given game
        // room. Bug being chased: UI desync where clients seem to miss
        // game:action pushes for stretches at a time.
        try {
          const { appLog } = await import('../services/appLogger');
          await appLog('info', 'system', 'socket:join_ok', {
            socketId: socket.id, userId: userId.slice(-6),
          }, { userId, gameId });
        } catch { /* non-fatal */ }
        return respond(true);
      } else {
        // Coalesce rejected-join log writes. At most one row per
        // (socket, gameId) per 60s.
        const lastLogTs = recentRejectedJoins.get(gameId) ?? 0;
        const shouldLog = now - lastLogTs >= JOIN_REJECT_LOG_DEDUPE_MS;
        if (shouldLog) {
          recentRejectedJoins.set(gameId, now);
          logger.warn('join:game rejected', {
            gameId,
            socketId: socket.id,
            userId,
            code: verdict.code,
          });
          try {
            const { appLog } = await import('../services/appLogger');
            await appLog('warn', 'system', 'socket:join_rejected', {
              socketId: socket.id, userId: userId.slice(-6), code: verdict.code,
            }, { userId, gameId });
          } catch { /* non-fatal */ }
        }
        return respond(false, verdict.code, verdict.message);
      }
    });

    // Leave game room
    socket.on('leave:game', (gameId: string) => {
      if (typeof gameId !== 'string' || !gameId) return;
      socket.leave(`game:${gameId}`);
      logger.info('Player left game room', { gameId, socketId: socket.id, userId });
      try {
        import('../services/appLogger').then(({ appLog }) =>
          appLog('info', 'system', 'socket:leave', {
            socketId: socket.id, userId: userId.slice(-6),
          }, { userId, gameId })
        ).catch(() => { /* non-fatal */ });
      } catch { /* non-fatal */ }
    });

    socket.on('disconnect', () => {
      logger.info('Client disconnected', { socketId: socket.id, userId });
      try {
        import('../services/appLogger').then(({ appLog }) =>
          appLog('info', 'system', 'socket:disconnect', {
            socketId: socket.id, userId: userId.slice(-6),
          }, { userId })
        ).catch(() => { /* non-fatal */ });
      } catch { /* non-fatal */ }
    });
  });

  logger.info('Socket.io initialized (JWT auth required)');
  return io;
}

/**
 * Decide whether a user is allowed to join a game's private socket room.
 * Pure function (no socket dependency) so it can be unit-tested.
 *
 * Rules:
 *  - gameId must be a non-empty string
 *  - userId must be a non-empty string
 *  - There must be a GamePlayer row binding (userId, gameId)
 *
 * Returns { ok: true } on accept, { ok: false, code, message } on reject.
 * Server errors return { ok: false, code: 'server_error' }.
 */
export async function checkGameRoomJoin(
  db: { gamePlayer: { findFirst: (args: any) => Promise<any> } },
  userId: string | undefined,
  gameId: string | undefined
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (typeof userId !== 'string' || !userId) {
    return { ok: false, code: 'unauthenticated', message: 'Not authenticated' };
  }
  if (typeof gameId !== 'string' || !gameId) {
    return { ok: false, code: 'invalid_game_id', message: 'Invalid game id' };
  }
  try {
    const seat = await db.gamePlayer.findFirst({
      where: { gameId, userId },
      select: { id: true, position: true },
    });
    if (!seat) {
      return { ok: false, code: 'not_seated', message: 'Not a seated player in this game' };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'server_error', message: 'Failed to verify seat' };
  }
}

/**
 * Get Socket.io instance
 */
export function getSocketServer(): SocketServer {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}

/**
 * Emit balance update to a specific user
 */
export function emitBalanceUpdate(userId: string, chips: string) {
  if (!io) return;
  
  io.to(`user:${userId}`).emit('balance:updated', { chips });
  logger.info('Emitted balance update', { userId, chips });
}

/**
 * Emit game event to all players in a game
 */
export function emitGameEvent(gameId: string, event: string, data: any) {
  if (!io) return;
  
  // Log how many sockets are in this room
  const room = io.sockets.adapter.rooms.get(`game:${gameId}`);
  const roomSize = room ? room.size : 0;
  
  io.to(`game:${gameId}`).emit(event, data);
  
  if (event === 'game:action') {
    logger.info(`SOCKET: ${event} to game:${gameId} (${roomSize} clients in room) next=${data?.nextPlayer?.slice(-6) || 'none'}`);
  }

  // DIAGNOSTIC (2026-05-13): persist room-emit telemetry to AppLog so we
  // can confirm post-hoc whether clients were in the room when high-value
  // events fired. Bug being chased: UI desync where turn indicator gets
  // stuck on the wrong player. If roomSize regularly drops below the seated
  // count, the issue is socket subscription, not client rendering.
  // Only log the high-signal events to keep log volume sane.
  if (event === 'game:action' || event === 'game:new-hand' || event === 'game:showdown' || event === 'game:fold-win' || event === 'game:completed' || event === 'game:started') {
    import('../services/appLogger').then(({ appLog }) =>
      appLog('info', 'system', `socket:emit:${event}`, {
        roomSize,
        nextPlayer: typeof data?.nextPlayer === 'string' ? data.nextPlayer.slice(-6) : null,
        userId: typeof data?.userId === 'string' ? data.userId.slice(-6) : null,
        action: data?.action ?? null,
      }, { gameId })
    ).catch(() => { /* non-fatal */ });
  }
}

/**
 * Broadcast a lobby-visibility event to every connected client (default
 * namespace). Used for player:joined / game:closed / game:updated so the
 * Lobby's game cards stay in sync without each client polling.
 *
 * Note: this is a TINY payload (game id + count) - no private hand data
 * or private seat info ever rides this channel. The Lobby is public,
 * the game room is private.
 */
export function emitLobbyEvent(event: string, data: any) {
  if (!io) return;
  io.emit(event, data);
}

/**
 * Emit personalized game state to each player in a game.
 * Each player gets their own view (their cards visible, others hidden).
 * Optimized: single DB query, personalize in memory per player.
 */
export async function broadcastGameState(gameId: string, playerUserIds: string[]) {
  if (!io) return;

  try {
    const { getGameState } = await import('../services/holdemGame');
    
    // For now, still fetch per-player (getGameState handles card hiding).
    // But do it in parallel to minimize wall-clock time.
    const states = await Promise.allSettled(
      playerUserIds.map(async (userId) => {
        const state = await getGameState(gameId, userId);
        return { userId, state };
      })
    );

    // Emit all at once (no awaits between emits)
    // DIAGNOSTIC (2026-05-13): also log whether each user-room had a
    // subscriber when we emitted. user-rooms are auto-joined on socket
    // auth; if 'subscribed=false' for a seated player, their socket
    // dropped or never reconnected (= the desync we're chasing).
    const userSubCounts: Record<string, number> = {};
    for (const result of states) {
      if (result.status === 'fulfilled') {
        const room = io!.sockets.adapter.rooms.get(`user:${result.value.userId}`);
        userSubCounts[result.value.userId.slice(-6)] = room ? room.size : 0;
        io!.to(`user:${result.value.userId}`).emit('game:state', result.value.state);
      }
    }
    try {
      const { appLog } = await import('../services/appLogger');
      await appLog('info', 'system', 'socket:broadcastGameState', {
        targets: playerUserIds.length,
        subscribers: userSubCounts,
      }, { gameId });
    } catch { /* non-fatal */ }
  } catch (err) {
    logger.error('Failed to broadcast game state', { gameId, error: err });
  }
}
