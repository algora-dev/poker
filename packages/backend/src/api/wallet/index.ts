import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import {
  generateDepositMessage,
  createDepositAuthorization,
  findActiveAuthorization,
} from '../../services/wallet';
import { checkActiveGameLockGlobal } from '../../services/activeGameLock';
import { logger } from '../../utils/logger';

const authorizeDepositSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid wallet address'),
  signature: z.string().min(1, 'Signature required'),
  message: z.string().min(1, 'Message required'),
});

export default async function walletRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/wallet/generate-message
   * Generate a message for the user to sign
   * Requires authentication
   */
  fastify.post(
    '/generate-message',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { walletAddress } = z.object({
          walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        }).parse(request.body);

        // Phase 10 [H-04]: refuse to issue a deposit challenge while the
        // user is seated at an active/waiting table. Prevents the user
        // from authorizing a deposit, joining a game, then having chips
        // credited mid-game.
        const lock = await checkActiveGameLockGlobal(request.user!.id);
        if (lock) {
          return reply.code(409).send({
            error: 'Conflict',
            code: lock.code,
            message: lock.message,
            gameId: lock.gameId,
            gameStatus: lock.status,
          });
        }

        const message = await generateDepositMessage(request.user!.id, walletAddress);

        return reply.send({ message });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
          });
        }

        logger.error('Generate message failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to generate message',
        });
      }
    }
  );

  /**
   * POST /api/wallet/authorize-deposit
   * Create a deposit authorization (10min window)
   * Requires authentication
   */
  fastify.post(
    '/authorize-deposit',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const data = authorizeDepositSchema.parse(request.body);

        // Phase 10 [H-04]: same check at the authorize step. Belt-and-braces
        // since a user could acquire a challenge then seat at a table
        // before submitting the signature.
        const lock = await checkActiveGameLockGlobal(request.user!.id);
        if (lock) {
          return reply.code(409).send({
            error: 'Conflict',
            code: lock.code,
            message: lock.message,
            gameId: lock.gameId,
            gameStatus: lock.status,
          });
        }

        const authorization = await createDepositAuthorization(
          request.user!.id,
          data.walletAddress,
          data.signature,
          data.message
        );

        logger.info('User authorized deposit', {
          userId: request.user!.id,
          walletAddress: data.walletAddress,
        });

        return reply.send({
          success: true,
          authorization: {
            id: authorization.id,
            walletAddress: authorization.walletAddress,
            expiresAt: authorization.expiresAt,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
          });
        }

        if (error instanceof Error) {
          if (error.message === 'Invalid signature') {
            return reply.code(400).send({
              error: 'Invalid signature',
              message: 'Signature verification failed',
            });
          }
        }

        logger.error('Authorize deposit failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to create authorization',
        });
      }
    }
  );

  /**
   * GET /api/wallet/check-authorization/:walletAddress
   * Check if a wallet has an active authorization
   */
  fastify.get(
    '/check-authorization/:walletAddress',
    async (request, reply) => {
      try {
        const { walletAddress } = z.object({
          walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        }).parse(request.params);

        const authorization = await findActiveAuthorization(walletAddress);

        if (!authorization) {
          return reply.send({
            authorized: false,
            message: 'No active authorization found',
          });
        }

        // Phase 10 [H-04]: this endpoint is unauthenticated. Do NOT leak
        // internal userId here. Callers (the wallet UI) only need to know
        // that the wallet has an active authorization and when it expires.
        return reply.send({
          authorized: true,
          expiresAt: authorization.expiresAt,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
          });
        }

        logger.error('Check authorization failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to check authorization',
        });
      }
    }
  );

  /**
   * POST /api/wallet/withdraw
   * Request a withdrawal
   */
  fastify.post(
    '/withdraw',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        // Withdrawals disabled during testing
        if (process.env.DISABLE_WITHDRAWALS === 'true') {
          return reply.code(400).send({ error: 'Withdrawals are temporarily disabled during testing' });
        }

        const { amount } = z.object({
          amount: z.number().min(1, 'Minimum withdrawal is 1.00 mUSD'),
        }).parse(request.body);

        const { processWithdrawal, ActiveGameMoneyLockedError } = await import(
          '../../services/withdrawal'
        );
        let result;
        try {
          result = await processWithdrawal(request.user!.id, amount);
        } catch (err: any) {
          if (err instanceof ActiveGameMoneyLockedError) {
            return reply.code(409).send({
              error: 'Conflict',
              code: err.code,
              message: err.message,
              gameId: err.gameId,
              gameStatus: err.gameStatus,
            });
          }
          throw err;
        }

        logger.info('Withdrawal processed', {
          userId: request.user!.id,
          amount,
          status: result.status,
          txHash: result.txHash,
        });

        return reply.send({
          success: true,
          withdrawalId: result.withdrawalId,
          txHash: result.txHash,
          status: result.status,
        });
      } catch (error: any) {
        logger.error('Withdrawal request failed', {
          userId: request.user!.id,
          error: error.message,
        });
        return reply.code(400).send({
          error: 'Withdrawal failed',
          message: error.message,
        });
      }
    }
  );

  /**
   * GET /api/wallet/money-lock
   * Phase 10 [H-04]: tells the client whether the user is currently
   * blocked from depositing/withdrawing because they are seated at an
   * active or waiting table. The frontend uses this to gate the buttons.
   * Backend still enforces independently — this is UX only.
   */
  fastify.get(
    '/money-lock',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const lock = await checkActiveGameLockGlobal(request.user!.id);
        if (!lock) return reply.send({ locked: false });
        return reply.send({
          locked: true,
          code: lock.code,
          message: lock.message,
          gameId: lock.gameId,
          gameStatus: lock.status,
        });
      } catch (error) {
        logger.error('money-lock check failed', { error });
        // Fail-closed for the UI: if we can't check, assume locked.
        return reply.code(503).send({ locked: true, code: 'lock_check_unavailable' });
      }
    }
  );

  /**
   * GET /api/wallet/withdrawals
   * Get withdrawal history
   */
  fastify.get(
    '/withdrawals',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { getWithdrawalHistory } = await import('../../services/withdrawal');
        const withdrawals = await getWithdrawalHistory(request.user!.id);

        return reply.send({
          withdrawals: withdrawals.map((w) => ({
            id: w.id,
            amount: (Number(w.amount) / 1_000_000).toFixed(2),
            status: w.status,
            txHash: w.txHash,
            requestedAt: w.requestedAt,
            completedAt: w.completedAt,
          })),
        });
      } catch (error) {
        logger.error('Get withdrawals failed', { error });
        return reply.code(500).send({ error: 'Failed to load withdrawals' });
      }
    }
  );
}
