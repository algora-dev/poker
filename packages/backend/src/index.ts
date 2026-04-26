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
  const port = Number(process.env.PORT) || CONFIG.PORT || 3000;
  console.log(`[STARTUP] PORT=${port}, NODE_ENV=${process.env.NODE_ENV}`);

  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  await app.register(jwt, { secret: CONFIG.JWT_SECRET });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(walletRoutes, { prefix: '/api/wallet' });
  await app.register(gamesRoutes, { prefix: '/api/games' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`[STARTUP] Fastify listening on 0.0.0.0:${port}`);
  } catch (err) {
    console.error('[STARTUP] Fastify listen FAILED:', err);
    process.exit(1);
  }

  initializeSocketServer(app.server);
  console.log('[STARTUP] Socket.io attached');

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
  console.error('[FATAL]', err);
  process.exit(1);
});
