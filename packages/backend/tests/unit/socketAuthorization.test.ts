/**
 * Phase 4 — Socket room authorization
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 4 and finding [H-03]:
 *   - On join:game, verify the authenticated user is a seated GamePlayer
 *     for that game before joining the private game room.
 *   - Invalid game id rejected cleanly.
 *   - Non-seated authenticated user cannot join.
 *
 * Tests target the pure checkGameRoomJoin function exported from socket/index.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkGameRoomJoin } from '../../src/socket';

function dbStub(seat: any) {
  return {
    gamePlayer: {
      findFirst: vi.fn(async () => seat),
    },
  };
}

describe('Phase 4 [H-03] — checkGameRoomJoin', () => {
  it('seated player can join their game room', async () => {
    const db = dbStub({ id: 'gp1', position: 'active' });
    const v = await checkGameRoomJoin(db, 'u1', 'g1');
    expect(v.ok).toBe(true);
    expect(db.gamePlayer.findFirst).toHaveBeenCalledWith({
      where: { gameId: 'g1', userId: 'u1' },
      select: { id: true, position: true },
    });
  });

  it('non-seated authenticated user cannot join', async () => {
    const db = dbStub(null);
    const v = await checkGameRoomJoin(db, 'u_spy', 'g1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('not_seated');
    }
  });

  it('invalid (empty) gameId rejected cleanly', async () => {
    const db = dbStub({ id: 'gp1', position: 'active' });
    const v = await checkGameRoomJoin(db, 'u1', '');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('invalid_game_id');
    }
    // Must not have hit the DB.
    expect(db.gamePlayer.findFirst).not.toHaveBeenCalled();
  });

  it('non-string gameId rejected cleanly', async () => {
    const db = dbStub({ id: 'gp1', position: 'active' });
    const v = await checkGameRoomJoin(db, 'u1', undefined);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('invalid_game_id');
    }
    expect(db.gamePlayer.findFirst).not.toHaveBeenCalled();
  });

  it('missing/empty userId rejected (defense in depth — auth middleware should catch first)', async () => {
    const db = dbStub({ id: 'gp1', position: 'active' });
    const v = await checkGameRoomJoin(db, undefined, 'g1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('unauthenticated');
    }
    expect(db.gamePlayer.findFirst).not.toHaveBeenCalled();
  });

  it('DB error is captured and surfaced as server_error (does not leak through)', async () => {
    const db = {
      gamePlayer: {
        findFirst: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      },
    };
    const v = await checkGameRoomJoin(db, 'u1', 'g1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('server_error');
    }
  });
});
