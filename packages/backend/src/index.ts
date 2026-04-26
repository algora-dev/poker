import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { createServer } from 'http';
import { CONFIG } from './config';
import { logger } from './utils/logger';
import { startBlockchainListener, stopBlockchainListener } from './blockchain/listener';
import { initializeSocketServer } from './socket';
import authRoutes from './api/auth';
import walletRoutes from './api/wallet';
import gamesRoutes from './api/games';
import adminRoutes from './api/admin';

async function start() {
  // Create raw HTTP server first
  const httpServer = createServer();

  // Create Fastify instance attached to the same HTTP server
  const app = Fastify({
    logger: false,
    serverFactory: (handler) => {
      httpServer.on('request', handler);
      return httpServer;
    },
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

  // Initialize Fastify (but don't call listen - we use serverFactory)
  await app.ready();

  // Attach Socket.io to the same HTTP server
  initializeSocketServer(httpServer);
  logger.info('Socket.io attached to HTTP server');

  // Start the shared HTTP server
  const port = CONFIG.PORT;
  httpServer.listen(port, '0.0.0.0', () => {
    logger.info(`Server listening on port ${port}`);
  });

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
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
