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

  /**
   * GET /api/admin/logs
   * Get recent app logs
   */
  fastify.get('/logs', async (request, reply) => {
    try {
      const query = request.query as any;
      if (query.secret !== CONFIG.ADMIN_SECRET) {
        return reply.code(403).send({ error: 'Invalid admin secret' });
      }

      const level = query.level || undefined;
      const category = query.category || undefined;
      const gameId = query.gameId || undefined;
      const limit = parseInt(query.limit || '50');

      const logs = await prisma.appLog.findMany({
        where: {
          ...(level && { level }),
          ...(category && { category }),
          ...(gameId && { gameId }),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      });

      return reply.send({
        count: logs.length,
        logs: logs.map(l => ({
          ...l,
          details: l.details ? JSON.parse(l.details) : null,
        })),
      });
    } catch (error) {
      return reply.code(500).send({ error: 'Failed to get logs' });
    }
  });

  /**
   * POST /api/admin/add-chips
   * Add chips to a user by email
   */
  fastify.post('/add-chips', async (request, reply) => {
    try {
      const { secret, email, amount } = z.object({
        secret: z.string(),
        email: z.string().email(),
        amount: z.number().min(0.01),
      }).parse(request.body);

      if (secret !== CONFIG.ADMIN_SECRET) {
        return reply.code(403).send({ error: 'Invalid admin secret' });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.code(404).send({ error: 'User not found', email });
      }

      const chipAmount = BigInt(Math.floor(amount * 1_000_000));

      const balance = await prisma.chipBalance.findUnique({ where: { userId: user.id } });
      if (!balance) {
        await prisma.chipBalance.create({
          data: { userId: user.id, chips: chipAmount },
        });
      } else {
        await prisma.chipBalance.update({
          where: { userId: user.id },
          data: { chips: { increment: chipAmount } },
        });
      }

      await prisma.chipAudit.create({
        data: {
          userId: user.id,
          operation: 'admin_adjustment',
          amountDelta: chipAmount,
          balanceBefore: balance?.chips || BigInt(0),
          balanceAfter: (balance?.chips || BigInt(0)) + chipAmount,
          notes: `Admin added ${amount} chips to ${email}`,
        },
      });

      logger.info('Admin added chips', { email, amount, userId: user.id });

      return reply.send({
        success: true,
        email,
        added: amount,
        newBalance: ((Number(balance?.chips || 0) + amount * 1_000_000) / 1_000_000).toFixed(2),
      });
    } catch (error) {
      logger.error('Add chips failed', { error });
      return reply.code(500).send({ error: 'Failed to add chips' });
    }
  });
}
