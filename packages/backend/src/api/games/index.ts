import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { CONFIG } from '../../config';
import {
  createGame,
  getGame,
  getActiveGames,
  getCompletedGames,
  joinGame,
  leaveGame,
  cancelGameBeforeStart,
  GameJoinMoneyLockedError,
} from '../../services/game';
import { initializeHand, getGameState, atomicStartGame } from '../../services/holdemGame';
import { processAction } from '../../services/pokerActions';
import { emitBalanceUpdate, emitGameEvent, emitLobbyEvent } from '../../socket';
import { logger } from '../../utils/logger';
import { prisma } from '../../db/client';

const createGameSchema = z.object({
  name: z.string().min(1, 'Game name required').max(50, 'Name too long'),
  minBuyIn: z.number().min(0.01, 'Minimum buy-in must be at least 0.01'),
  maxBuyIn: z.number().min(0.01, 'Maximum buy-in must be at least 0.01'),
  creatorBuyIn: z.number().min(0.01).optional(),
  // Server defaults aligned with the lobby UI defaults (0.10/0.20 with a
  // 10-chip starting buy-in). Updated post-playtest 2026-05-11.
  smallBlind: z.number().min(0.01, 'Small blind must be at least 0.01').optional().default(0.10),
  bigBlind: z.number().min(0.01, 'Big blind must be at least 0.01').optional().default(0.20),
});

export default async function gamesRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/games/create
   * Create a new game
   */
  fastify.post(
    '/create',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const data = createGameSchema.parse(request.body);

        // Convert to BigInt (chips use 6 decimals like mUSD)
        const minBuyInChips = BigInt(Math.floor(data.minBuyIn * 1_000_000));
        const maxBuyInChips = BigInt(Math.floor(data.maxBuyIn * 1_000_000));
        const creatorBuyInChips = data.creatorBuyIn
          ? BigInt(Math.floor(data.creatorBuyIn * 1_000_000))
          : minBuyInChips;
        const smallBlindChips = BigInt(Math.floor(data.smallBlind * 1_000_000));
        const bigBlindChips = BigInt(Math.floor(data.bigBlind * 1_000_000));

        const result = await createGame(
          request.user!.id,
          data.name,
          minBuyInChips,
          maxBuyInChips,
          smallBlindChips,
          bigBlindChips,
          creatorBuyInChips
        );

        // Emit balance update to creator
        if (result.newBalance) {
          emitBalanceUpdate(request.user!.id, result.newBalance);
        }

        logger.info('User created game', {
          userId: request.user!.id,
          gameId: result.game.id,
          minBuyIn: minBuyInChips.toString(),
          maxBuyIn: maxBuyInChips.toString(),
        });

        return reply.send({
          success: true,
          game: {
            id: result.game.id,
            name: result.game.name,
            minBuyIn: data.minBuyIn,
            maxBuyIn: data.maxBuyIn,
            smallBlind: data.smallBlind,
            bigBlind: data.bigBlind,
            status: result.game.status,
            createdAt: result.game.createdAt,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
          });
        }

        // Phase 10 [H-04] hardening: 409 if user is already seated.
        if (error instanceof GameJoinMoneyLockedError) {
          return reply.code(409).send({
            error: 'Conflict',
            code: error.code,
            message: error.message,
            gameId: error.gameId,
            gameStatus: error.gameStatus,
          });
        }

        if (error instanceof Error) {
          if (error.message.includes('Insufficient chips')) {
            return reply.code(400).send({
              error: 'Insufficient chips',
              message: error.message,
            });
          }
        }

        logger.error('Create game failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to create game',
        });
      }
    }
  );

  /**
   * GET /api/games/lobby
   * Get all active games
   */
  fastify.get(
    '/lobby',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const games = await getActiveGames();

        // Format games for frontend
        const formattedGames = games.map((game) => ({
          id: game.id,
          name: game.name,
          minBuyIn: (Number(game.minBuyIn) / 1_000_000).toFixed(2),
          maxBuyIn: (Number(game.maxBuyIn) / 1_000_000).toFixed(2),
          smallBlind: (Number(game.smallBlind) / 1_000_000).toFixed(2),
          bigBlind: (Number(game.bigBlind) / 1_000_000).toFixed(2),
          players: game.players.length,
          maxPlayers: game.maxPlayers,
          status: game.status,
          creator: game.players[0]?.user.username || 'Unknown',
          createdAt: game.createdAt,
        }));

        return reply.send({ games: formattedGames });
      } catch (error) {
        logger.error('Get lobby failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to load games',
        });
      }
    }
  );

  /**
   * GET /api/games/history
   * Get completed games
   */
  fastify.get(
    '/history',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const games = await getCompletedGames(20);

        const formatted = games.map((game) => ({
          id: game.id,
          name: game.name,
          status: game.status,
          players: game.players.length,
          playerNames: game.players.map((p: any) => p.user.username),
          handsPlayed: game.hands.length,
          createdAt: game.createdAt,
          completedAt: game.completedAt,
        }));

        return reply.send({ games: formatted });
      } catch (error) {
        logger.error('Get history failed', { error });
        return reply.code(500).send({ error: 'Failed to load history' });
      }
    }
  );

  /**
   * GET /api/games/:id
   * Get game details
   */
  fastify.get(
    '/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);

        const game = await getGame(id);

        // Format for frontend
        const formattedGame = {
          id: game.id,
          name: game.name,
          buyIn: (Number(game.minBuyIn) / 1_000_000).toFixed(2),
          status: game.status,
          players: game.players.map((p) => ({
            userId: p.userId,
            username: p.user.username,
            chipStack: (Number(p.chipStack) / 1_000_000).toFixed(2),
            position: p.position,
            seatIndex: p.seatIndex,
          })),
          createdAt: game.createdAt,
          startedAt: game.startedAt,
          completedAt: game.completedAt,
        };

        return reply.send({ game: formattedGame });
      } catch (error) {
        if (error instanceof Error && error.message === 'Game not found') {
          return reply.code(404).send({
            error: 'Not found',
            message: 'Game not found',
          });
        }

        logger.error('Get game failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to load game',
        });
      }
    }
  );

  /**
   * POST /api/games/:id/join
   * Join an existing game
   */
  fastify.post(
    '/:id/join',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);
        const body = z.object({
          buyInAmount: z.number().min(0.01).optional(),
        }).parse(request.body || {});

        const buyInChips = body.buyInAmount
          ? BigInt(Math.floor(body.buyInAmount * 1_000_000))
          : undefined;

        const result = await joinGame(request.user!.id, id, buyInChips);

        // Emit balance update to joiner
        emitBalanceUpdate(request.user!.id, result.newBalance);

        // Emit player joined event (game stays in "waiting" until started).
        // Game-room scoped: alerts everyone already at the table.
        emitGameEvent(id, 'player:joined', {
          gameId: id,
          playerCount: result.game.players?.length || 0,
        });
        // Lobby-wide broadcast: alerts the Lobby pages so their game
        // cards refresh seat counts in real time. Without this the
        // Lobby stays stale and users click Join on a card whose seat
        // was just filled. (Playtest 2026-05-12 phantom-seat report.)
        emitLobbyEvent('player:joined', {
          gameId: id,
          playerCount: result.game.players?.length || 0,
        });
        // Playtest 2026-05-13 fix: creator could not see joiners (or start
        // the game) until manual refresh. Force a full personalized state
        // push to every seated player so their waiting-room UI updates
        // immediately, regardless of whether their socket received the
        // player:joined event in time to trigger a refetch.
        try {
          const { broadcastGameState } = await import('../../socket');
          const playerIds = (result.game.players || [])
            .map((p: any) => p.userId)
            .filter((u: any) => typeof u === 'string' && u.length > 0);
          if (playerIds.length > 0) {
            // Fire-and-forget; don't block the HTTP response.
            broadcastGameState(id, playerIds).catch((err) =>
              logger.warn('broadcastGameState after join failed (non-fatal)', {
                gameId: id, error: err instanceof Error ? err.message : String(err),
              })
            );
          }
        } catch (err) {
          logger.warn('broadcastGameState import failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        logger.info('User joined game', {
          userId: request.user!.id,
          gameId: id,
        });

        return reply.send({
          success: true,
          game: {
            id: result.game.id,
            name: result.game.name,
            status: result.game.status,
            startedAt: result.game.startedAt,
          },
          // No newBalance - not deducted yet
        });
      } catch (error) {
        // Phase 10 [H-04] hardening: 409 if user is already seated elsewhere.
        if (error instanceof GameJoinMoneyLockedError) {
          return reply.code(409).send({
            error: 'Conflict',
            code: error.code,
            message: error.message,
            gameId: error.gameId,
            gameStatus: error.gameStatus,
          });
        }

        if (error instanceof Error) {
          if (
            error.message.includes('not found') ||
            error.message.includes('not accepting') ||
            error.message.includes('already in') ||
            error.message.includes('full')
          ) {
            return reply.code(400).send({
              error: 'Bad request',
              message: error.message,
            });
          }

          if (error.message.includes('Insufficient chips')) {
            return reply.code(400).send({
              error: 'Insufficient chips',
              message: error.message,
            });
          }
        }

        logger.error('Join game failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to join game',
        });
      }
    }
  );

  /**
   * POST /api/games/:id/start
   * Start the game (creator only)
   */
  fastify.post(
    '/:id/start',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);

        // Get game
        const game = await prisma.game.findUnique({
          where: { id },
          include: { players: true },
        });

        if (!game) {
          return reply.code(404).send({
            error: 'Not found',
            message: 'Game not found',
          });
        }

        // Only creator can start
        if (game.createdBy !== request.user!.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Only the game creator can start the game',
          });
        }

        // Must be in waiting status
        if (game.status !== 'waiting') {
          return reply.code(400).send({
            error: 'Bad request',
            message: 'Game already started or completed',
          });
        }

        // Need at least 2 players
        if (game.players.length < 2) {
          return reply.code(400).send({
            error: 'Bad request',
            message: 'Need at least 2 players to start',
          });
        }

        // PHASE 5 [H-05]: atomic game start via atomicStartGame helper.
        // Status flip and first-hand init happen in ONE transaction. If hand
        // init throws, the transaction rolls back and status stays 'waiting'.
        // Status guard makes concurrent start requests idempotent: only the
        // first one transitions; subsequent calls get a clean 409.
        // See audits/t3-poker/06-dave-fix-prompt.md Phase 5.
        const startResult = await atomicStartGame(id);
        if (startResult.ok !== true) {
          if (startResult.code === 'already_started') {
            return reply.code(409).send({
              error: 'Conflict',
              message: startResult.message,
            });
          }
          logger.error('Atomic game start failed; rolled back', {
            gameId: id,
            error: startResult.message,
          });
          return reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to start game',
          });
        }

        logger.info('Game started by creator (atomic)', {
          gameId: id,
          creatorId: request.user!.id,
          playerCount: game.players.length,
        });

        // ONLY now respond success - the game truly has a first hand.
        reply.send({ success: true, message: 'Game started!' });

        // Side effects (broadcasts) outside the transaction.
        try {
          emitGameEvent(id, 'game:started', { gameId: id });
          const { broadcastGameState: bgs } = await import('../../socket');
          const pIds = game.players.map((p: any) => p.userId);
          bgs(id, pIds).catch(() => {});
        } catch (err) {
          logger.error('Post-start broadcast failed (game still started ok)', {
            gameId: id,
            error: (err as any)?.message || String(err),
          });
        }
      } catch (error) {
        logger.error('Start game failed', {
          error,
          stack: error instanceof Error ? error.stack : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
        return reply.code(500).send({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Failed to start game',
        });
      }
    }
  );

  /**
   * GET /api/games/:id/state
   * Get current game state for active player
   */
  fastify.get(
    '/:id/state',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);

        const state = await getGameState(id, request.user!.id);

        return reply.send(state);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('not found') || error.message.includes('not in this game')) {
            return reply.code(404).send({
              error: 'Not found',
              message: error.message,
            });
          }
        }

        logger.error('Get game state failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to get game state',
        });
      }
    }
  );

  /**
   * POST /api/games/:id/action
   * Perform a poker action (fold, check, call, raise)
   *
   * Rate limit: per authenticated user, since this endpoint is auth-required.
   * Real poker decisions take seconds; 60/min is a generous human ceiling and
   * blocks scripted spam without ever triggering on legitimate play.
   */
  fastify.post(
    '/:id/action',
    {
      preHandler: authMiddleware,
      config: {
        rateLimit: CONFIG.HARNESS_BYPASS_GLOBAL_RATELIMIT
          ? false
          : {
              max: 60,
              timeWindow: '1 minute',
              keyGenerator: (req: any) => (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`),
            },
      },
    },
    async (request, reply) => {
      // Declared at outer scope so the catch block (which logs them) can see them.
      let id: string | undefined;
      let action: 'fold' | 'check' | 'call' | 'raise' | 'all-in' | undefined;
      try {
        ({ id } = z.object({ id: z.string() }).parse(request.params));
        let raiseAmount: number | undefined;
        ({ action, raiseAmount } = z
          .object({
            action: z.enum(['fold', 'check', 'call', 'raise', 'all-in']),
            raiseAmount: z.number().optional(),
          })
          .parse(request.body));

        const { appLog, logError } = await import('../../services/appLogger');
        await appLog('info', 'action', `Player ${action}`, { action, raiseAmount, userId: request.user!.id.slice(-6) }, { userId: request.user!.id, gameId: id });

        const result = await processAction(id, request.user!.id, action, raiseAmount);

        // IMMEDIATELY emit action event with ALL data clients need
        emitGameEvent(id, 'game:action', {
          gameId: id,
          action,
          userId: request.user!.id,
          nextPlayer: result.nextPlayer || null,
          pot: result.pot || null,
          currentBet: result.currentBet || null,
          stage: result.stage || null,
          actionAmount: result.actionAmount || null,
          timestamp: Date.now(),
        });

        // Broadcast full personalized state to all players (replaces client-side refetch)
        if (!result.gameOver) {
          const gPlayers = await prisma.game.findUnique({ where: { id }, select: { players: { select: { userId: true } } } });
          if (gPlayers) {
            const { broadcastGameState: bgsAction } = await import('../../socket');
            bgsAction(id, gPlayers.players.map(p => p.userId)).catch(() => {});
          }
        }

        // Game-over detection: if processAction ran closeGameInTx, the
        // game's status flipped to 'completed'. Compose final standings
        // from MoneyEvent (game_cashout) rows so the Game Over screen
        // shows correct winners/amounts, not the stale mid-hand snapshot
        // captured by the frontend's broadcastGameState loop.
        //
        // Bug fixed 2026-05-13: Game Over previously displayed the last
        // in-progress chipStack snapshot, which on all-in fast-forward
        // could show a bot with ~5 chips as "winner" even though the
        // hero (Shaun) actually won the whole pot (logs: hand 9 had
        // mid-hand snapshot Shaun=0/Bot=5.1 captured between two all-ins).
        let finalStandingsPayload: any = null;
        try {
          const postGame = await prisma.game.findUnique({
            where: { id },
            select: { status: true },
          });
          if (postGame?.status === 'completed') {
            const cashouts = await prisma.moneyEvent.findMany({
              where: { gameId: id, eventType: { in: ['game_cashout', 'game_cancel_refund'] } },
              orderBy: { serverTime: 'asc' },
            });
            const userIds = Array.from(new Set(cashouts.map(c => c.userId)));
            const users = await prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, username: true },
            });
            const nameByUser = new Map(users.map(u => [u.id, u.username]));
            // Sum refunds per user (defensive: one row per user expected,
            // but be tolerant of edge cases like split-pot remainders).
            const totalByUser = new Map<string, bigint>();
            for (const c of cashouts) {
              totalByUser.set(c.userId, (totalByUser.get(c.userId) ?? 0n) + BigInt(c.amount));
            }
            const standings = Array.from(totalByUser.entries()).map(([userId, amount]) => ({
              userId,
              username: nameByUser.get(userId) ?? userId.slice(-6),
              chipStack: amount.toString(),
            }));
            standings.sort((a, b) => Number(BigInt(b.chipStack) - BigInt(a.chipStack)));
            finalStandingsPayload = { gameId: id, standings };
          }
        } catch (err) {
          logger.warn('Failed to compose final standings (non-fatal)', {
            gameId: id, error: err instanceof Error ? err.message : String(err),
          });
        }

        // Emit specific events
        if (result.showdownResults) {
          // Hand completed via showdown - emit results
          emitGameEvent(id, 'game:showdown', {
            gameId: id,
            ...result.showdownResults,
          });

          // After showdown: 10-second countdown so players can read the
          // result modal, then a 3-tone airport-style chime, then a 2s
          // pause, then the new hand is dealt. (Shaun 2026-05-14:
          // 8s countdown then chime + deal animation fire AT THE SAME
          // INSTANT — the previous 2s gap felt too long.)
          logger.info('Starting 8s countdown before next hand', { gameId: id });
          emitGameEvent(id, 'game:next-hand-countdown', { gameId: id, seconds: 8 });
          setTimeout(async () => {
            try {
              logger.info('8s countdown finished, starting next hand + chime', { gameId: id });
              // Chime + deal-animation trigger fire together at t=8s.
              emitGameEvent(id, 'game:next-hand-chime', { gameId: id });
              const game = await prisma.game.findUnique({ where: { id } });
              if (game && game.status === 'in_progress') {
                await initializeHand(id);
                emitGameEvent(id, 'game:new-hand', { gameId: id });
                // Broadcast full state
                const gp = await prisma.game.findUnique({ where: { id }, select: { players: { select: { userId: true } } } });
                const { broadcastGameState: bgs2 } = await import('../../socket');
                bgs2(id, gp?.players.map(p => p.userId) || []).catch(() => {});
              }
            } catch (err: any) {
              logger.error('Failed to start next hand', {
                gameId: id,
                error: err?.message || String(err),
                stack: err?.stack,
              });
            }
          }, 8_000); // 8s total: chime + deal anim fire simultaneously at t=8s
        } else if (result.gameOver) {
          // Hand completed via fold
          if (result.foldWinResult) {
            // Someone won because everyone else folded
            emitGameEvent(id, 'game:fold-win', {
              gameId: id,
              ...result.foldWinResult,
            });
          }
          emitGameEvent(id, 'game:updated', {
            gameId: id,
            action,
            userId: request.user!.id,
          });

          // Fold-win uses the same 8s countdown + simultaneous chime +
          // deal-animation flow as showdown for consistent pacing.
          // (Shaun 2026-05-14.)
          emitGameEvent(id, 'game:next-hand-countdown', { gameId: id, seconds: 8 });
          setTimeout(async () => {
            try {
              emitGameEvent(id, 'game:next-hand-chime', { gameId: id });
              const game = await prisma.game.findUnique({ where: { id } });
              if (game && game.status === 'in_progress') {
                await initializeHand(id);
                emitGameEvent(id, 'game:new-hand', { gameId: id });
                const gp2 = await prisma.game.findUnique({ where: { id }, select: { players: { select: { userId: true } } } });
                const { broadcastGameState: bgs3 } = await import('../../socket');
                bgs3(id, gp2?.players.map(p => p.userId) || []).catch(() => {});
              }
            } catch (err) {
              logger.error('Failed to start next hand after fold', {
                gameId: id,
                error: (err as any)?.message || String(err),
                stack: (err as any)?.stack,
              });
            }
          }, 8_000); // 8s total: chime + deal anim fire simultaneously
        } else {
          // Normal action - game:action already emitted above
        }

        // If the game has just completed, emit a final-standings event so
        // the frontend Game Over screen can show authoritative winner +
        // chip totals (not the stale mid-hand snapshot it captures from
        // in_progress state broadcasts).
        if (finalStandingsPayload) {
          emitGameEvent(id, 'game:completed', finalStandingsPayload);
        }

        logger.info('Player action processed', {
          gameId: id,
          userId: request.user!.id,
          action,
        });

        return reply.send({
          success: true,
          result,
        });
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes('Not your turn') ||
            error.message.includes('Invalid') ||
            error.message.includes('Cannot check')
          ) {
            return reply.code(400).send({
              error: 'Bad request',
              message: error.message,
            });
          }
        }

        const errorMsg = error instanceof Error ? error.message : 'Unknown error';

        // Log to DB for persistent debugging
        try {
          const { logError } = await import('../../services/appLogger');
          await logError('action', `Action ${action} failed`, error, { userId: request.user!.id, gameId: id });
        } catch (_) {}

        return reply.code(500).send({
          error: 'Internal server error',
          message: errorMsg,
        });
      }
    }
  );

  /**
   * POST /api/games/:id/cancel
   * Cancel a game before it starts (creator only, waiting status)
   */
  fastify.post(
    '/:id/cancel',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);

        const result = await cancelGameBeforeStart(request.user!.id, id);

        // Emit balance update
        // No balance update - players choose buy-in when joining

        logger.info('Game cancelled', {
          gameId: id,
          userId: request.user!.id,
        });

        return reply.send({
          success: true,
          ...result,
        });
      } catch (error) {
        if (error instanceof Error) {
          if (
            error.message.includes('not found') ||
            error.message.includes('Only the') ||
            error.message.includes('Cannot cancel')
          ) {
            return reply.code(400).send({
              error: 'Bad request',
              message: error.message,
            });
          }
        }

        logger.error('Cancel game failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to cancel game',
        });
      }
    }
  );

  /**
   * POST /api/games/:id/leave
   *
   * Leave a game you're seated at.
   *
   *   - waiting + last player  -> game is cancelled, chips refunded
   *   - waiting + others remain -> chips refunded, your seat removed
   *   - in_progress             -> you're marked eliminated; remaining
   *                                stack + open-pot share will be paid
   *                                out when the game closes
   *   - not in this game        -> idempotent 200 with mode=idempotent_noop
   *
   * All paths route through services/game.leaveGame which composes the
   * canonical closeGame + ChipAudit + MoneyEvent ledger writes inside one
   * transaction. No money is created or destroyed.
   */
  fastify.post(
    '/:id/leave',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string() }).parse(request.params);
        const userId = request.user!.id;

        const result = await leaveGame(userId, id);

        // Broadcast: socket events so peers update without polling.
        try {
          emitGameEvent(id, 'game:updated', {
            gameId: id,
            playerLeft: userId,
            mode: result.mode,
            gameStatusAfter: result.gameStatusAfter,
          });
          // Lobby-wide broadcast so seat-count cards refresh in real
          // time. Same pattern as join.
          emitLobbyEvent('game:updated', {
            gameId: id,
            gameStatusAfter: result.gameStatusAfter,
          });
          // If the game was cancelled as a side-effect, fire game:closed
          // too so spectators can route back to the lobby.
          if (result.mode === 'closed_last_player') {
            emitGameEvent(id, 'game:closed', {
              gameId: id,
              reason: 'pre_start_cancel',
            });
            emitLobbyEvent('game:closed', {
              gameId: id,
              reason: 'pre_start_cancel',
            });
          }
          if (result.refundAmount && result.refundAmount !== '0') {
            emitBalanceUpdate(userId, result.newBalance ?? '0');
          }
        } catch (e) {
          logger.warn('leaveGame socket broadcast failed (non-fatal)', {
            gameId: id,
            userId,
            error: (e as Error).message,
          });
        }

        logger.info('Player left game', {
          gameId: id,
          userId,
          mode: result.mode,
          refund: result.refundAmount,
        });

        return reply.send({ success: true, ...result });
      } catch (error) {
        logger.error('Leave game failed', { error });
        if (error instanceof Error) {
          return reply.code(400).send({
            error: 'Bad request',
            message: error.message,
          });
        }
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to leave game',
        });
      }
    }
  );
}
