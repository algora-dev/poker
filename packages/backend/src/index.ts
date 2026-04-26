import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { CONFIG } from './config';
import { logger } from './utils/logger';
import { startBlockchainListener, stopBlockchainListener } from './blockchain/listener';
import { initializeSocketServer } from './socket';
import authRoutes from './api/auth';
import walletRoutes from './api/wallet';
import gamesRoutes from './api/games';
import adminRoutes from './api/admin';

async function start() {
  // Create Fastify instance
  const app = Fastify({
    logger: false,
  });

  // Register plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(jwt, {
    secret: CONFIG.JWT_SECRET,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(walletRoutes, { prefix: '/api/wallet' });
  await app.register(gamesRoutes, { prefix: '/api/games' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // Start HTTP server
  await app.listen({ port: CONFIG.PORT, host: '0.0.0.0' });
  logger.info(`HTTP server listening on port ${CONFIG.PORT}`);

  // Attach Socket.io to the SAME server (required for single-port hosting like Railway)
  // Get the underlying Node http.Server from Fastify
  const httpServer = app.server;
  initializeSocketServer(httpServer);
  logger.info('Socket.io attached to HTTP server');

  // Start blockchain listener
  startBlockchainListener();

  // Start background jobs
  import('./jobs/autoStartGames');
  import('./jobs/turnTimer');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    stopBlockchainListener();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
