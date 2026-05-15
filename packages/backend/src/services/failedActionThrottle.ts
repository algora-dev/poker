/**
 * Per-(user,game) failed-action throttle.
 *
 * SECURITY [audit-30, Gerald-flagged 2026-05-15]:
 * The action endpoint already has a 60/min per-user rate limit for
 * ALL action attempts (successful or rejected). Gerald asked for a
 * separate, tighter ceiling on REJECTED actions: an attacker probing
 * for vulnerabilities can fire many failed requests without hitting
 * the success-path throttle. This module caps failures at
 * 5/(user,game)/60s and returns 429 above that.
 *
 * Process-local; sufficient for single-instance Railway deploy.
 * Horizontal scale needs a Redis-backed counter (out of scope, phase 3).
 *
 * Memory bound: one entry per active (userId, gameId) pair, GC'd when
 * the window expires. With ~thousands of concurrent users that's
 * sub-MB even at saturation.
 */

const FAILURE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 5;

interface FailureBucket {
  count: number;
  /** ms timestamps of each failure in the current window. */
  hits: number[];
}

const buckets = new Map<string, FailureBucket>();

function bucketKey(userId: string, gameId: string): string {
  return `${userId}:${gameId}`;
}

/**
 * Record a failed action. Returns true if the caller has now EXCEEDED
 * the limit (i.e. this failure pushes them over) — caller should
 * respond with 429.
 */
export function recordFailedAction(userId: string, gameId: string): {
  exceeded: boolean;
  retryAfterMs: number;
} {
  const key = bucketKey(userId, gameId);
  const now = Date.now();
  const cutoff = now - FAILURE_WINDOW_MS;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { count: 0, hits: [] };
    buckets.set(key, bucket);
  }

  // Drop hits outside the window.
  bucket.hits = bucket.hits.filter((t) => t >= cutoff);
  bucket.hits.push(now);
  bucket.count = bucket.hits.length;

  if (bucket.count > FAILURE_LIMIT) {
    // Time until the oldest hit ages out of the window.
    const retryAfterMs = bucket.hits[0] + FAILURE_WINDOW_MS - now;
    return { exceeded: true, retryAfterMs };
  }

  return { exceeded: false, retryAfterMs: 0 };
}

/**
 * Clear a (user,game) bucket. Called when the user takes a SUCCESSFUL
 * action so a probe-and-recover pattern doesn't accumulate failures
 * indefinitely.
 */
export function clearFailedActions(userId: string, gameId: string): void {
  buckets.delete(bucketKey(userId, gameId));
}

/**
 * Manual GC. Called every 5 minutes from a setInterval below. Drops
 * any bucket whose newest hit is older than 2x the window — by then
 * the bucket is effectively empty and just consuming memory.
 */
function gc() {
  const cutoff = Date.now() - 2 * FAILURE_WINDOW_MS;
  for (const [key, bucket] of buckets) {
    const newest = bucket.hits[bucket.hits.length - 1] ?? 0;
    if (newest < cutoff) {
      buckets.delete(key);
    }
  }
}

setInterval(gc, 5 * 60_000).unref?.();

/**
 * Test-only: wipe all state between scenarios.
 */
export function _internalResetFailedActionThrottle(): void {
  buckets.clear();
}

/**
 * Test-only: introspect current count.
 */
export function _internalGetFailedActionCount(
  userId: string,
  gameId: string
): number {
  const bucket = buckets.get(bucketKey(userId, gameId));
  return bucket?.count ?? 0;
}
