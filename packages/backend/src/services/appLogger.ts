import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Log to both console AND database for persistent debugging.
 * Non-blocking — failures to write DB logs don't crash the app.
 */
/**
 * Log categories.
 *
 * `security_event` was added 2026-05-15 (audit-30, Gerald-flagged) to
 * separate adversarial / probing rejections from normal action errors
 * so ops dashboards can distinguish:
 *   - `action` errors  — expected gameplay errors (Cannot check, etc.)
 *   - `security_event` — rejected actions that may indicate probing
 *     (wrong-user, dead-seat, replay-stale, throttle-exceeded)
 */
export type AppLogCategory =
  | 'action'
  | 'game'
  | 'auth'
  | 'system'
  | 'timer'
  | 'security_event';

export async function appLog(
  level: 'error' | 'warn' | 'info',
  category: AppLogCategory,
  message: string,
  details?: Record<string, any>,
  context?: { userId?: string; gameId?: string; handId?: string }
) {
  // Always log to console
  logger[level](message, details);

  // Write to DB (non-blocking, don't await in critical paths)
  try {
    await prisma.appLog.create({
      data: {
        level,
        category,
        message,
        details: details ? JSON.stringify(details, (_, v) => typeof v === 'bigint' ? v.toString() : v) : null,
        userId: context?.userId,
        gameId: context?.gameId,
        handId: context?.handId,
      },
    });
  } catch (err) {
    // Don't crash if logging fails
    logger.error('Failed to write app log to DB', { err });
  }
}

/**
 * Quick error logger for catch blocks
 */
export async function logError(
  category: AppLogCategory,
  message: string,
  error: any,
  context?: { userId?: string; gameId?: string; handId?: string }
) {
  await appLog('error', category, message, {
    error: error?.message || String(error),
    stack: error?.stack?.split('\n').slice(0, 3).join(' | '),
  }, context);
}
