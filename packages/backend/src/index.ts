import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { CONFIG } from './config';
import { logger } from './utils/logger';
import { startBlockchainListener, stopBlockchainListener } from './blockchain/listener';
import { initializeSocketServer } from './socket';
import authRoutes from './api/auth';
import walletRoutes from './api/wallet';
import gamesRoutes from './api/games';
import adminRoutes from './api/admin';

async function start() {
  const app = Fastify({
    logger: false,
    trustProxy: true, // Railway uses reverse proxy
  });

  // CORS — must be first
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    exposedHeaders: ['Content-Type'],
  });

  await app.register(jwt, { secret: CONFIG.JWT_SECRET });

  // Health check — simplest possible route
  app.get('/health', async (_req, reply) => {
    reply.code(200).send({ status: 'ok' });
  });

  // API routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(walletRoutes, { prefix: '/api/wallet' });
  await app.register(gamesRoutes, { prefix: '/api/games' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // Listen on Railway's PORT
  const port = Number(process.env.PORT) || CONFIG.PORT || 3000;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`HTTP server listening on port ${port}`);

  // Attach Socket.io AFTER listen
  initializeSocketServer(app.server);
  logger.info('Socket.io attached');

  // Background services
  startBlockchainListener();
  import('./jobs/autoStartGames');
  import('./jobs/turnTimer');

  process.on('SIGTERM', async () => {
    stopBlockchainListener();
    await app.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
