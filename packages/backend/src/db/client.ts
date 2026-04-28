import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
  transactionOptions: {
    maxWait: 10000,  // 10s max wait for transaction to start
    timeout: 30000,  // 30s max transaction duration
  },
});

// Log Prisma warnings and errors via Winston
prisma.$on('warn', (e) => {
  logger.warn(`Prisma warning: ${e.message}`);
});

prisma.$on('error', (e) => {
  logger.error(`Prisma error: ${e.message}`);
});

export { prisma };
