import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUser, authenticateUser, linkWallet } from '../../services/auth';
import { authMiddleware } from '../../middleware/auth';
import { logger } from '../../utils/logger';

// Validation schemas
const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password must be at most 100 characters'),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const linkWalletSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid wallet address'),
});

// Per-route rate limit: tight on credential endpoints.
// keyed by IP + provided email so attackers can't easily rotate one axis.
const credKey = (req: any) => {
  const ip = req.ip || 'unknown';
  const email = (req.body && (req.body as any).email) || '';
  return `${ip}|${String(email).toLowerCase()}`;
};
const credentialLimit = {
  rateLimit: {
    max: 10,                  // 10 attempts/min per (IP, email)
    timeWindow: '1 minute',
    keyGenerator: credKey,
  },
};
// Signup rate limit. Tuned 2026-05-15 (Shaun playtest feedback):
// the previous 5/hour/IP was tripping legitimate testers who shared
// an IP (office wifi, mobile carrier NAT, household). Bumped to
// 30/hour/IP — still tight enough to block automated abuse but
// loose enough that a group of 4-6 testers signing up from the
// same network can all get in without hitting the wall.
//
// Anti-cheat phase 2 will add additional protections (per-user
// failure throttle, JWT tokenType strictness) before public mainnet.
const signupLimit = {
  rateLimit: {
    max: 30,
    timeWindow: '1 hour',
  },
};

export default async function authRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/auth/signup
   * Register a new user
   */
  fastify.post('/signup', { config: signupLimit }, async (request, reply) => {
    try {
      // Validate request body. Cast clarifies that all fields are required
      // post-validation (Zod's runtime check enforces it).
      const data = signupSchema.parse(request.body) as {
        email: string;
        username: string;
        password: string;
        walletAddress?: string;
      };

      // Create user
      const user = await createUser(data);

      // Generate JWT tokens.
      // SECURITY [audit-30 H-03]: tokenType claim differentiates
      // access vs refresh so /refresh can reject access tokens. The
      // auth middleware ignores tokenType (any valid token from us
      // identifies the user), but the refresh route enforces it.
      const accessToken = fastify.jwt.sign(
        { userId: user.id, tokenType: 'access' },
        { expiresIn: '15m' }
      );

      const refreshToken = fastify.jwt.sign(
        { userId: user.id, tokenType: 'refresh' },
        { expiresIn: '7d' }
      );

      logger.info('User registered', {
        userId: user.id,
        email: user.email,
        username: user.username,
      });

      return reply.code(201).send({
        user,
        accessToken,
        refreshToken,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: error.errors,
        });
      }

      if (error instanceof Error) {
        if (
          error.message.includes('already registered') ||
          error.message.includes('already taken') ||
          error.message.includes('already linked')
        ) {
          return reply.code(409).send({
            error: 'Conflict',
            message: error.message,
          });
        }
      }

      logger.error('Signup failed', { error });
      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Failed to create account',
      });
    }
  });

  /**
   * POST /api/auth/login
   * Authenticate a user
   */
  fastify.post('/login', { config: credentialLimit }, async (request, reply) => {
    try {
      // Validate request body. Cast clarifies post-validation shape.
      const data = loginSchema.parse(request.body) as {
        email: string;
        password: string;
      };

      // Authenticate user
      const user = await authenticateUser(data);

      // Generate JWT tokens. tokenType added (audit-30 H-03).
      const accessToken = fastify.jwt.sign(
        { userId: user.id, tokenType: 'access' },
        { expiresIn: '15m' }
      );

      const refreshToken = fastify.jwt.sign(
        { userId: user.id, tokenType: 'refresh' },
        { expiresIn: '7d' }
      );

      logger.info('User logged in', {
        userId: user.id,
        email: user.email,
      });

      return reply.send({
        user,
        accessToken,
        refreshToken,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: error.errors,
        });
      }

      if (error instanceof Error) {
        if (error.message.includes('Invalid email or password')) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: error.message,
          });
        }
      }

      logger.error('Login failed', { error });
      return reply.code(500).send({
        error: 'Internal server error',
        message: 'Failed to login',
      });
    }
  });

  /**
   * POST /api/auth/refresh
   * Refresh access token using refresh token
   */
  fastify.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      // Verify refresh token. After jwtVerify(), request.user is typed as
      // AuthUser, but on this route we actually want the raw signed payload
      // (we sign { userId, tokenType } only).
      await request.jwtVerify();
      const payload = (request.user as unknown) as {
        userId: string;
        tokenType?: 'access' | 'refresh';
      };

      // SECURITY [audit-30 H-03, tightened in audit-31 H-01]: refresh
      // endpoint REQUIRES `tokenType === 'refresh'`. Access tokens and
      // legacy no-claim tokens are both rejected. The earlier
      // soft-transition (accept missing claim with a warning) was
      // removed on Gerald's call: pre-production is the right time
      // to force re-login rather than hold a 7-day legacy hole open.
      if (payload.tokenType !== 'refresh') {
        return reply.code(401).send({
          error: 'Unauthorized',
          message:
            'Refresh requires a refresh token. Access / legacy tokens are rejected; please log in again.',
        });
      }

      // Generate new access token (with tokenType claim).
      const accessToken = fastify.jwt.sign(
        { userId: payload.userId, tokenType: 'access' },
        { expiresIn: '15m' }
      );

      return reply.send({ accessToken });
    } catch (error) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
      });
    }
  });

  /**
   * POST /api/auth/link-wallet
   * Link wallet address to account (requires authentication)
   */
  fastify.post(
    '/link-wallet',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        // Validate request body
        const data = linkWalletSchema.parse(request.body);

        // Link wallet
        const user = await linkWallet(request.user!.id, data.walletAddress);

        logger.info('Wallet linked', {
          userId: user.id,
          walletAddress: data.walletAddress,
        });

        return reply.send({ user });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: error.errors,
          });
        }

        if (error instanceof Error) {
          if (error.message.includes('already linked')) {
            return reply.code(409).send({
              error: 'Conflict',
              message: error.message,
            });
          }
        }

        logger.error('Link wallet failed', { error });
        return reply.code(500).send({
          error: 'Internal server error',
          message: 'Failed to link wallet',
        });
      }
    }
  );

  /**
   * GET /api/auth/me
   * Get current user info (requires authentication)
   */
  fastify.get(
    '/me',
    { preHandler: authMiddleware },
    async (request, reply) => {
      return reply.send({ user: request.user });
    }
  );

  /**
   * POST /api/auth/logout
   * Logout (client-side token removal, this just confirms)
   */
  fastify.post('/logout', async (request, reply) => {
    return reply.send({ message: 'Logged out successfully' });
  });

  /**
   * POST /api/auth/avatar
   * Set player avatar (1-10)
   */
  fastify.post(
    '/avatar',
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const { avatarId } = z.object({
          avatarId: z.number().min(1).max(10),
        }).parse(request.body);

        const { prisma } = await import('../../db/client');
        await prisma.user.update({
          where: { id: request.user!.id },
          data: { avatarId },
        });

        return reply.send({ success: true, avatarId });
      } catch (error) {
        return reply.code(400).send({ error: 'Invalid avatar selection' });
      }
    }
  );
}
