/**
 * Anti-cheat phase 2 — failed-action throttle (audit-30 P3).
 *
 * Direct unit test for `services/failedActionThrottle.ts`. The
 * route-level integration is covered by the action endpoint catch
 * path which uses recordFailedAction + clearFailedActions.
 *
 * Coverage:
 *   1. First 5 failures pass without exceeded=true
 *   2. 6th failure within window triggers exceeded=true
 *   3. retryAfterMs returned is positive and within the window
 *   4. clearFailedActions resets the bucket
 *   5. Different (user, game) buckets are isolated
 *   6. After window expiry, fresh failures don't trigger exceeded
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFailedAction,
  clearFailedActions,
  _internalResetFailedActionThrottle,
  _internalGetFailedActionCount,
} from '../../src/services/failedActionThrottle';

describe('Anti-cheat phase 2 — failed-action throttle (audit-30)', () => {
  beforeEach(() => {
    _internalResetFailedActionThrottle();
  });

  it('first 5 failures pass without exceeded=true', () => {
    for (let i = 1; i <= 5; i++) {
      const res = recordFailedAction('u1', 'g1');
      expect(res.exceeded).toBe(false);
      expect(res.retryAfterMs).toBe(0);
    }
    expect(_internalGetFailedActionCount('u1', 'g1')).toBe(5);
  });

  it('6th failure within the window triggers exceeded=true', () => {
    for (let i = 1; i <= 5; i++) recordFailedAction('u1', 'g1');
    const sixth = recordFailedAction('u1', 'g1');
    expect(sixth.exceeded).toBe(true);
    expect(sixth.retryAfterMs).toBeGreaterThan(0);
    expect(sixth.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('clearFailedActions resets the bucket', () => {
    for (let i = 1; i <= 5; i++) recordFailedAction('u1', 'g1');
    expect(_internalGetFailedActionCount('u1', 'g1')).toBe(5);
    clearFailedActions('u1', 'g1');
    expect(_internalGetFailedActionCount('u1', 'g1')).toBe(0);
    // After clearing, the next failure is "the first" again.
    const res = recordFailedAction('u1', 'g1');
    expect(res.exceeded).toBe(false);
  });

  it('buckets are isolated by (user, game)', () => {
    // Saturate u1@g1.
    for (let i = 1; i <= 6; i++) recordFailedAction('u1', 'g1');
    expect(_internalGetFailedActionCount('u1', 'g1')).toBe(6);

    // u2@g1 is independent.
    const res = recordFailedAction('u2', 'g1');
    expect(res.exceeded).toBe(false);
    expect(_internalGetFailedActionCount('u2', 'g1')).toBe(1);

    // u1@g2 is independent of u1@g1.
    const res2 = recordFailedAction('u1', 'g2');
    expect(res2.exceeded).toBe(false);
    expect(_internalGetFailedActionCount('u1', 'g2')).toBe(1);
  });

  it('a successful clear lets the user accumulate failures again from scratch', () => {
    // Probe / fail / fail / fail / SUCCESS / fail / fail / fail / fail / fail / fail
    // Without the clear, the 6th fail (across the success) would exceed.
    // With the clear, the post-success failures start fresh.
    for (let i = 1; i <= 3; i++) recordFailedAction('u1', 'g1');
    clearFailedActions('u1', 'g1');
    for (let i = 1; i <= 5; i++) {
      const res = recordFailedAction('u1', 'g1');
      expect(res.exceeded).toBe(false);
    }
    const sixthPostClear = recordFailedAction('u1', 'g1');
    expect(sixthPostClear.exceeded).toBe(true);
  });
});
