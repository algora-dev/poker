/**
 * Phase 10 [H-04] hardening — per-user money mutex.
 *
 * Serializes all paths that move a user's money (off-table balance or
 * on-table chip stack) so the active-game lock cannot be raced past.
 *
 * Implementation: PostgreSQL transaction-scoped advisory lock keyed by
 * the userId. Acquired with `pg_advisory_xact_lock(key)`; auto-released
 * when the surrounding transaction commits or rolls back, so a crashing
 * tx can never leave the lock held.
 *
 * Required call sites (all inside the same Prisma `$transaction` that
 * does the balance/stack mutation):
 *   - processWithdrawal deduct
 *   - createGame buy-in deduct
 *   - joinGame buy-in deduct
 *   - blockchain credit path (deposit credit)
 *   - closeGame refund/cashout (so close cannot race a withdrawal)
 *
 * Two requests for the same userId trying to move money will queue on
 * the lock; reads outside this lock are unaffected.
 *
 * The advisory lock key is a stable 63-bit hash of the userId so a
 * single key space is shared across processes that connect to the same
 * Postgres database.
 */
import { createHash } from 'node:crypto';

/**
 * Map a userId (cuid string) to a stable 63-bit integer for use as the
 * advisory lock key. We mask to 63 bits so the value always fits in a
 * signed bigint and Postgres accepts it as `bigint`.
 */
function userIdToLockKey(userId: string): bigint {
  if (!userId) throw new Error('userMoneyMutex: userId required');
  const digest = createHash('sha256').update('uml:' + userId).digest();
  // Take the first 8 bytes as a big-endian unsigned 64-bit, then mask
  // the high bit so the value is non-negative when interpreted as
  // signed bigint (Postgres bigint is signed).
  const hi = BigInt(digest.readUInt32BE(0));
  const lo = BigInt(digest.readUInt32BE(4));
  const u64 = (hi << 32n) | lo;
  return u64 & ((1n << 63n) - 1n);
}

/**
 * Acquire the per-user money mutex for the duration of the supplied
 * transaction. Must be called BEFORE any balance read/write that the
 * caller wants serialized.
 *
 * Returns the lock key for logging/debug; callers normally don't need it.
 */
export async function acquireUserMoneyMutex(
  tx: { $executeRaw: (...args: any[]) => Promise<unknown> } | any,
  userId: string
): Promise<bigint> {
  const key = userIdToLockKey(userId);
  // tx is a Prisma transaction client; $executeRawUnsafe lets us pass the
  // computed bigint as a parameter. We use the parameterized form so the
  // value is never inlined as text.
  // pg_advisory_xact_lock returns void; awaiting is enough to block.
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::bigint)', key);
  return key;
}

/**
 * Convenience: run a fn inside a Prisma transaction with the per-user
 * money mutex held for its full duration.
 *
 * Caller passes the prisma client; this function opens the transaction.
 */
export async function withUserMoneyMutex<T>(
  prisma: { $transaction: <R>(fn: (tx: any) => Promise<R>) => Promise<R> } | any,
  userId: string,
  fn: (tx: any) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx: any) => {
    await acquireUserMoneyMutex(tx, userId);
    return fn(tx);
  });
}

// Re-exported for tests.
export const __test = { userIdToLockKey };
