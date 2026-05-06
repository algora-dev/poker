/**
 * Phase 6 — Table size cap and auto-start opt-in
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 6 and findings [M-03][M-04]:
 *   - Hard cap table size at 8 players for now.
 *   - Disable auto-start for money games unless host explicitly opts in.
 */

import { describe, it, expect } from 'vitest';
import { MAX_TABLE_SIZE } from '../../src/services/game';

describe('Phase 6 [M-03] — table size cap constant', () => {
  it('MAX_TABLE_SIZE is 8', () => {
    expect(MAX_TABLE_SIZE).toBe(8);
  });
});

// createGame is hard to unit-test without a DB harness because it touches
// chipBalance + game + gamePlayer + chipAudit + handEvent in one transaction.
// We assert the hard cap declaratively via the exported constant and via the
// guard contract by importing the function and checking the validation path
// rejects > 8 BEFORE any DB call.
describe('Phase 6 [M-03] — createGame rejects oversize tables before any DB call', () => {
  it('rejects maxPlayers > 8 with a clear error', async () => {
    // Lazy-import after env stubs are in place.
    const { createGame } = await import('../../src/services/game');
    await expect(
      createGame(
        'u1',
        'big table',
        10n,
        100n,
        1n,
        2n,
        undefined,
        { maxPlayers: 9 }
      )
    ).rejects.toThrow(/maxPlayers cannot exceed 8/);
  });

  it('rejects maxPlayers < 2', async () => {
    const { createGame } = await import('../../src/services/game');
    await expect(
      createGame('u1', 'solo', 10n, 100n, 1n, 2n, undefined, { maxPlayers: 1 })
    ).rejects.toThrow(/maxPlayers must be an integer >= 2/);
  });

  it('rejects non-integer maxPlayers', async () => {
    const { createGame } = await import('../../src/services/game');
    await expect(
      createGame('u1', 'fractional', 10n, 100n, 1n, 2n, undefined, {
        maxPlayers: 7.5,
      })
    ).rejects.toThrow(/maxPlayers must be an integer/);
  });
});
