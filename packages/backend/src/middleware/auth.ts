import { FastifyRequest, FastifyReply } from 'fastify';
import { getUserById } from '../services/auth';

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      username: string;
      avatarId: number | null;
      walletAddress: string | null;
      chips: string;
    };
  }
}

/**
 * Middleware to verify JWT token and attach user to request
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    // Verify JWT token
    await request.jwtVerify();

    // Get user from token payload
    const payload = request.user as { userId: string };

    // Fetch fresh user data
    const user = await getUserById(payload.userId);

    if (!user) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'User not found',
      });
    }

    // Attach user to request
    request.user = user;
  } catch (error) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}

/**
 * Optional auth - attaches user if token present, but doesn't require it
 */
export async function optionalAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    await request.jwtVerify();
    const payload = request.user as { userId: string };
    const user = await getUserById(payload.userId);
    if (user) {
      request.user = user;
    }
  } catch {
    // Token invalid or missing, continue without user
  }
}
