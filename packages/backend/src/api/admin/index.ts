import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { authMiddleware } from '../../middleware/auth';
import { cleanupStuckGames, cancelGame } from '../../services/admin';
import { logger } from '../../utils/logger';
import { CONFIG } from '../../config';
import { prisma } from '../../db/client';
import {
  spawnBots,
  killBotsAtGame,
  listBots,
  isBotFillAllowed,
  BotFillError,
  validateSpawnRequest,
  MAX_BOTS_PER_CALL,
} from '../../services/botFill/registry';

/**
 * Constant-time admin secret check that ALSO refuses to authenticate if
 * the configured secret is empty (otherwise a deploy without ADMIN_SECRET
 * set would let any caller in by sending an empty `secret`).
 */
function isAdminSecretValid(provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = CONFIG.ADMIN_SECRET;
  if (!expected) return false;
  // timingSafeEqual requires equal-length buffers; pad/compare via SHA digest
  // would be overkill here, so length-mismatch returns false explicitly.
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

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

      if (!isAdminSecretValid(secret)) {
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

      if (!isAdminSecretValid(secret)) {
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

      if (!isAdminSecretValid(secret)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Invalid admin secret',
        });
      }

      // ChipAudit has no Prisma relation to User, so we resolve usernames in
      // a single follow-up query keyed by userId.
      const refunds = await prisma.chipAudit.findMany({
        where: {
          operation: 'game_refund',
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 20,
      });

      const userIds = Array.from(new Set(refunds.map((r) => r.userId)));
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true },
          })
        : [];
      const usernameById = new Map(users.map((u) => [u.id, u.username]));

      return reply.send({
        success: true,
        refunds: refunds.map((r) => ({
          userId: r.userId,
          username: usernameById.get(r.userId) ?? null,
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
      if (!isAdminSecretValid(query.secret)) {
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

      if (!isAdminSecretValid(secret)) {
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

  /**
   * POST /api/admin/spawn-bots
   * Dev-only: fill remaining seats at a game with bots driven by the same
   * harness-style logic, so a human can play-test from the frontend.
   *
   * Body: { secret, gameId, count, strategy?, buyInChips?, bankrollChips?,
   *         thinkMs? }
   *
   * Auth: requires the same ADMIN_SECRET as the rest of the admin surface.
   * Production hard-block: refuses unless ALLOW_BOT_FILL=1 is set.
   */
  fastify.post('/spawn-bots', async (request, reply) => {
    try {
      if (!isBotFillAllowed()) {
        return reply.code(403).send({
          error: 'Forbidden',
          code: 'bot_fill_disabled',
          message:
            'Bot-fill is disabled in this environment (set ALLOW_BOT_FILL=1 to enable in production).',
        });
      }

      const body = z
        .object({
          secret: z.string(),
          gameId: z.string(),
          count: z.number().int().min(1).max(MAX_BOTS_PER_CALL),
          strategy: z.enum(['random', 'tight', 'loose']).optional(),
          buyInChips: z.number().min(0.01).optional(),
          bankrollChips: z.number().min(0.01).optional(),
          thinkMs: z.number().int().min(0).max(10_000).optional(),
        })
        .parse(request.body);

      if (!isAdminSecretValid(body.secret)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Invalid admin secret' });
      }

      // Re-validate (defense in depth) and also normalize the strategy field.
      validateSpawnRequest({
        gameId: body.gameId,
        count: body.count,
        strategy: body.strategy ?? 'random',
      });

      // Default buy-in / bankroll to whatever the game requires. We read
      // the game record so callers don't have to know the table's blinds.
      const game = await prisma.game.findUnique({
        where: { id: body.gameId },
        select: {
          minBuyIn: true,
          maxBuyIn: true,
          status: true,
          maxPlayers: true,
          players: { select: { id: true } },
        },
      });
      if (!game) {
        return reply.code(404).send({ error: 'Not found', message: 'Game not found' });
      }
      if (game.status !== 'waiting' && game.status !== 'in_progress') {
        return reply.code(409).send({
          error: 'Conflict',
          code: 'invalid_game_status',
          message: `Cannot spawn bots into a game with status ${game.status}`,
        });
      }
      const freeSeats = Math.max(0, game.maxPlayers - game.players.length);
      if (freeSeats <= 0) {
        return reply.code(409).send({
          error: 'Conflict',
          code: 'table_full',
          message: 'No seats available at this table',
        });
      }
      const requestedCount = Math.min(body.count, freeSeats);

      const minBuyInChips = Number(game.minBuyIn) / 1_000_000;
      const maxBuyInChips = Number(game.maxBuyIn) / 1_000_000;
      const buyInChips = body.buyInChips ?? minBuyInChips;
      if (buyInChips < minBuyInChips || buyInChips > maxBuyInChips) {
        return reply.code(400).send({
          error: 'Bad request',
          code: 'invalid_buy_in',
          message: `buyInChips must be between ${minBuyInChips} and ${maxBuyInChips}`,
        });
      }
      // Default bankroll = 5x buy-in so a bot can rebuy a few times if the
      // table loops. Caller can override.
      const bankrollChips = body.bankrollChips ?? buyInChips * 5;

      // Bot HTTP calls go to localhost so we never depend on external DNS
      // for a feature that's already gated to dev.
      const botBaseUrl = `http://127.0.0.1:${CONFIG.PORT}`;

      const result = await spawnBots({
        gameId: body.gameId,
        count: requestedCount,
        strategy: body.strategy ?? 'random',
        baseUrl: botBaseUrl,
        buyInChips,
        bankrollChips,
        adminSecret: body.secret,
        thinkMs: body.thinkMs,
      });

      return reply.send({
        success: true,
        batchId: result.batchId,
        requested: body.count,
        spawned: result.spawned.length,
        clamped: requestedCount < body.count,
        bots: result.spawned,
      });
    } catch (error) {
      if (error instanceof BotFillError) {
        return reply.code(error.httpStatus).send({
          error: 'Bot-fill error',
          code: error.code,
          message: error.message,
        });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Validation failed', details: error.errors });
      }
      logger.error('[BOT_FILL] spawn-bots failed', { error: (error as Error)?.message });
      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Failed to spawn bots',
      });
    }
  });

  /**
   * POST /api/admin/kill-bots
   * Terminate all bot sessions at a game. Body: { secret, gameId }.
   */
  fastify.post('/kill-bots', async (request, reply) => {
    try {
      const { secret, gameId } = z
        .object({ secret: z.string(), gameId: z.string() })
        .parse(request.body);
      if (!isAdminSecretValid(secret)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Invalid admin secret' });
      }
      const killed = killBotsAtGame(gameId);
      return reply.send({ success: true, killed });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Validation failed', details: error.errors });
      }
      logger.error('[BOT_FILL] kill-bots failed', { error: (error as Error)?.message });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/admin/bots?secret=...
   * List active bot sessions across the process.
   */
  fastify.get('/bots', async (request, reply) => {
    try {
      const { secret } = z.object({ secret: z.string() }).parse(request.query);
      if (!isAdminSecretValid(secret)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Invalid admin secret' });
      }
      return reply.send({
        success: true,
        allowed: isBotFillAllowed(),
        bots: listBots(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Validation failed', details: error.errors });
      }
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
