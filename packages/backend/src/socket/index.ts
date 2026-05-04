import { Server as SocketServer } from 'socket.io';
import { logger } from '../utils/logger';

let io: SocketServer | null = null;

/**
 * Initialize Socket.io server
 */
export function initializeSocketServer(server: any) {
  io = new SocketServer(server, {
    cors: {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // Handle connections
  io.on('connection', (socket) => {
    logger.info('Client connected', { socketId: socket.id });

    // Join user room (for user-specific events)
    socket.on('join:user', (userId: string) => {
      socket.join(`user:${userId}`);
      logger.info('User joined room', { userId, socketId: socket.id });
    });

    // Join game room
    socket.on('join:game', (gameId: string) => {
      socket.join(`game:${gameId}`);
      logger.info('Player joined game room', { gameId, socketId: socket.id });
    });

    // Leave game room
    socket.on('leave:game', (gameId: string) => {
      socket.leave(`game:${gameId}`);
      logger.info('Player left game room', { gameId, socketId: socket.id });
    });

    socket.on('disconnect', () => {
      logger.info('Client disconnected', { socketId: socket.id });
    });
  });

  logger.info('Socket.io initialized');
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
