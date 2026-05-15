import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Log to both console AND database for persistent debugging.
 * Non-blocking — failures to write DB logs don't crash the app.
 */
/**
 * Log categories.
 *
 * Audit-30 added `security_event`; audit-31 (Gerald M-03) split that
 * further so dashboards aren't drowned in honest gameplay mistakes:
 *
 *   - `action`           — normal action lifecycle info (Player call, ...)
 *   - `gameplay_reject`  — expected gameplay-rule rejections
 *                          (Not your turn, Cannot check, Nothing to
 *                          call, min-raise, Stale action). These are
 *                          frequent and BENIGN — stale UI clicks,
 *                          mid-action races. Keep them separate so
 *                          the security signal isn't polluted.
 *   - `security_event`   — rejections that may indicate probing:
 *                          wrong-user, dead-seat, malformed input,
 *                          throttle exceeded, auth/socket probing.
 *
 * Action route logic decides which bucket a rejection lands in based
 * on the error message shape.
 */
export type AppLogCategory =
  | 'action'
  | 'game'
  | 'auth'
  | 'system'
  | 'timer'
  | 'gameplay_reject'
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
