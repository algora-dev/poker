import { Server as SocketServer, Socket } from 'socket.io';
import { createVerifier } from 'fast-jwt';
import { CONFIG } from '../config';
import { logger } from '../utils/logger';

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
  io.use((socket, next) => {
    const token = extractToken(socket);
    if (!token) {
      logger.warn('Socket auth rejected: no token', { socketId: socket.id });
      return next(new Error('Unauthorized: missing token'));
    }
    try {
      const payload = verifyJwt(token) as { userId?: string };
      if (!payload?.userId) {
        return next(new Error('Unauthorized: invalid token payload'));
      }
      socket.userId = payload.userId;
      return next();
    } catch (err) {
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

    // Join game room
    socket.on('join:game', (gameId: string) => {
      if (typeof gameId !== 'string' || !gameId) return;
      socket.join(`game:${gameId}`);
      logger.info('Player joined game room', { gameId, socketId: socket.id, userId });
    });

    // Leave game room
    socket.on('leave:game', (gameId: string) => {
      if (typeof gameId !== 'string' || !gameId) return;
      socket.leave(`game:${gameId}`);
      logger.info('Player left game room', { gameId, socketId: socket.id, userId });
    });

    socket.on('disconnect', () => {
      logger.info('Client disconnected', { socketId: socket.id, userId });
    });
  });

  logger.info('Socket.io initialized (JWT auth required)');
  return io;
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
    for (const result of states) {
      if (result.status === 'fulfilled') {
        io!.to(`user:${result.value.userId}`).emit('game:state', result.value.state);
      }
    }
  } catch (err) {
    logger.error('Failed to broadcast game state', { gameId, error: err });
  }
}
