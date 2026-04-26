import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

// Log Prisma warnings and errors via Winston
prisma.$on('warn', (e) => {
  logger.warn(`Prisma warning: ${e.message}`);
});

prisma.$on('error', (e) => {
  logger.error(`Prisma error: ${e.message}`);
});

export { prisma };
