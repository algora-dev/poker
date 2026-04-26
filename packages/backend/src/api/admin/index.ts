import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { cleanupStuckGames, cancelGame } from '../../services/admin';
import { logger } from '../../utils/logger';
import { CONFIG } from '../../config';
import { prisma } from '../../db/client';

export default async function adminRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/admin/cleanup-games
   * Clean up stuck/abandoned games and refund chips
   * Admin only (requires ADMIN_SECRET)
   */
  fastify.post('/cleanup-games', async (request, reply) => {
    try {
      // Check admin secret
      const { secret } = z
        .object({
          secret: z.string(),
        })
        .parse(request.body);

      if (secret !== CONFIG.ADMIN_SECRET) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Invalid admin secret',
        });
      }

      const result = await cleanupStuckGames();

      logger.info('Admin cleanup executed', result);

      return reply.send({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error('Cleanup failed', { error });
      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Failed to cleanup games',
      });
    }
  });

  /**
   * POST /api/admin/cancel-game
   * Cancel a specific game and refund players
   * Admin only
   */
  fastify.post('/cancel-game', async (request, reply) => {
    try {
      const { secret, gameId, reason } = z
        .object({
          secret: z.string(),
          gameId: z.string(),
          reason: z.string(),
        })
        .parse(request.body);

      if (secret !== CONFIG.ADMIN_SECRET) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Invalid admin secret',
        });
      }

      const result = await cancelGame(gameId, reason);

      return reply.send({
        success: true,
        ...result,
      });
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({
          error: 'Bad request',
          message: error.message,
        });
      }

      logger.error('Cancel game failed', { error });
      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Failed to cancel game',
      });
    }
  });

  /**
   * GET /api/admin/refund-log
   * Get recent chip refunds for debugging
   */
  fastify.get('/refund-log', async (request, reply) => {
    try {
      const { secret } = z
        .object({ secret: z.string() })
        .parse(request.query);

      if (secret !== CONFIG.ADMIN_SECRET) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Invalid admin secret',
        });
      }

      const refunds = await prisma.chipAudit.findMany({
        where: {
          operation: 'game_refund',
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 20,
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      return reply.send({
        success: true,
        refunds: refunds.map((r) => ({
          userId: r.userId,
          username: r.user.username,
          amount: r.amountDelta.toString(),
          balanceBefore: r.balanceBefore.toString(),
          balanceAfter: r.balanceAfter.toString(),
          gameId: r.reference,
          timestamp: r.createdAt,
        })),
      });
    } catch (error) {
      logger.error('Get refund log failed', { error });
      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Failed to get refund log',
      });
    }
  });
}
