import { FastifyRequest, FastifyReply } from 'fastify';
import { getUserById } from '../services/auth';

/**
 * Type augmentation for the user we attach to FastifyRequest after auth.
 *
 * NOTE: @fastify/jwt also declares `request.user` (the verified JWT payload).
 * We overwrite that field with the full user record AFTER calling
 * `request.jwtVerify()`, so by the time route handlers see `request.user` it
 * is always our `AuthUser` (or undefined on optional-auth routes when there
 * was no token).
 *
 * To express that to TypeScript without conflicting with @fastify/jwt's own
 * declaration, we tell @fastify/jwt that the verified payload type is also
 * `AuthUser` (so the union resolves cleanly to a single shape).
 */
export interface AuthUser {
  id: string;
  email: string;
  username: string;
  avatarId: number | null;
  walletAddress: string | null;
  chips: string;
}

/**
 * Internal JWT payload shape we sign and verify.
 *
 * `tokenType` was added 2026-05-15 (audit-30 H-03) so /refresh can
 * distinguish access tokens from refresh tokens. Optional in the type
 * for backward compatibility with tokens issued before that fix
 * landed; those will lack the claim until they expire (7d max).
 */
interface JwtPayload {
  userId: string;
  tokenType?: 'access' | 'refresh';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;     // what we sign
    user: AuthUser;          // what `request.user` becomes after authMiddleware
  }
}

/**
 * Middleware to verify JWT token and attach the full user record.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    // Verify JWT signature/expiry. After this call `request.user` is the
    // verified JWT payload (typed as AuthUser via the FastifyJWT augmentation).
    await request.jwtVerify();

    // Re-read the payload as the raw shape we signed so we can fetch the user.
    const payload = request.user as unknown as JwtPayload;

    const user = await getUserById(payload.userId);
    if (!user) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'User not found',
      });
    }

    // Attach full user record. Subsequent handlers see request.user: AuthUser.
    request.user = user as AuthUser;
  } catch (error) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}

/**
 * Optional auth - attaches user if token present, but doesn't require it.
 */
export async function optionalAuthMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
) {
  try {
    await request.jwtVerify();
    const payload = request.user as unknown as JwtPayload;
    const user = await getUserById(payload.userId);
    if (user) {
      request.user = user as AuthUser;
    }
  } catch {
    // Token invalid or missing, continue without user
  }
}
