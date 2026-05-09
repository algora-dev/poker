/**
 * Layer B — negative legality tests (Gerald audit-22 M-01).
 *
 * Each scenario deliberately scripts an ILLEGAL action and verifies that
 * either:
 *   (a) the legality oracle pre-validation catches it (default DSL mode), OR
 *   (b) the engine rejects it as a 4xx-class error (when allowIllegalActions=true).
 *
 * Both paths are valuable:
 *   - (a) proves the test infrastructure won't accept malformed scripts.
 *   - (b) proves the production engine rejects illegal inputs (defence-in-depth).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScripted } from './dsl';
import { clearForcedDeck } from './forcedDeck';
import { legalActions, validateScriptedAction } from './legality';

vi.mock('../../src/db/client', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, prop) => {
        const w: any = (globalThis as any).__t3PokerSimWorld;
        if (!w) throw new Error('sim world not installed');
        return w[prop as string];
      },
    }
  ),
}));
vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../src/services/blindSchedule', () => ({
  checkBlindIncrease: () => null,
  getBlindLevel: () => ({ smallBlind: 500_000n, bigBlind: 1_000_000n }),
}));
vi.mock('../../src/socket', () => ({
  emitGameEvent: vi.fn(),
  emitBalanceUpdate: vi.fn(),
  broadcastGameState: vi.fn(),
  checkGameRoomJoin: vi.fn(),
}));
vi.mock('../../src/services/poker/deck', async (importOriginal) => {
  const real = await importOriginal<any>();
  const helper = await import('./forcedDeck');
  return {
    ...real,
    shuffleDeck: (deck: any[]) => {
      const forced = helper.getActiveForcedDeck();
      if (forced) return [...forced];
      return real.shuffleDeck(deck);
    },
  };
});

describe('Layer B — negative legality tests', () => {
  beforeEach(() => {
    clearForcedDeck();
  });

  // ---- Direct unit tests of the legality oracle ----
  // These don't run the engine; they call validateScriptedAction directly
  // on synthetic PlayerView inputs.

  it('NEG-01 (oracle): check while owing chips is rejected', () => {
    const view = {
      seatIndex: 0,
      userId: 'p',
      handNumber: 1,
      stage: 'preflop' as const,
      currentBet: 6_000_000n,
      bigBlind: 1_000_000n,
      alreadyInOnStreet: 1_000_000n, // posted BB only
      chipStack: 199_000_000n,
      pot: 7_500_000n,
      livePlayers: 2,
    };
    // currentBet=6, alreadyIn=1 → owed=5 → check is illegal.
    const r = validateScriptedAction(view, 1_000_000n, { kind: 'check' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/'check' not legal/);
      expect(r.legal.kinds).not.toContain('check');
      expect(r.legal.kinds).toContain('call');
      expect(r.legal.kinds).toContain('fold');
    }
  });

  it('NEG-02 (oracle): raise below min increment is rejected', () => {
    const view = {
      seatIndex: 0,
      userId: 'p',
      handNumber: 1,
      stage: 'preflop' as const,
      currentBet: 6_000_000n,        // someone raised to 6 with a 5-chip increment over BB
      bigBlind: 1_000_000n,
      alreadyInOnStreet: 1_000_000n,
      chipStack: 199_000_000n,
      pot: 13_000_000n,
      livePlayers: 3,
    };
    // lastRaiseIncrement=5. Min legal raise total = 6 + 5 = 11.
    // Try to raise to 8 (only 2 more on top of currentBet) — illegal.
    const r = validateScriptedAction(view, 5_000_000n, {
      kind: 'raise',
      raiseTotal: 8_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/raise total \d+ < min/);
    }
  });

  it('NEG-03 (oracle): raise above stack is rejected', () => {
    const view = {
      seatIndex: 0,
      userId: 'p',
      handNumber: 1,
      stage: 'preflop' as const,
      currentBet: 6_000_000n,
      bigBlind: 1_000_000n,
      alreadyInOnStreet: 1_000_000n,
      chipStack: 199_000_000n, // 199 chips left
      pot: 7_500_000n,
      livePlayers: 2,
    };
    // Max legal raise total = alreadyIn + stack = 1 + 199 = 200.
    // Try to raise to 500 — beyond stack.
    const r = validateScriptedAction(view, 5_000_000n, {
      kind: 'raise',
      raiseTotal: 500_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/raise total \d+ > max/);
      expect(r.reason).toMatch(/exceed stack/);
    }
  });

  it('NEG-04 (oracle): call when owed=0 is rejected (use check instead)', () => {
    const view = {
      seatIndex: 0,
      userId: 'p',
      handNumber: 1,
      stage: 'flop' as const,
      currentBet: 0n,                 // post-flop, no bets yet
      bigBlind: 1_000_000n,
      alreadyInOnStreet: 0n,
      chipStack: 199_000_000n,
      pot: 13_000_000n,
      livePlayers: 2,
    };
    const r = validateScriptedAction(view, 1_000_000n, { kind: 'call' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/'call' not legal/);
      expect(r.legal.kinds).toContain('check');
    }
  });

  // ---- DSL-level integration: a script with an illegal action surfaces
  //      as a legalityFailure, not silent script acceptance ----

  it('NEG-05 (DSL): scripted check while owing chips surfaces legalityFailure', async () => {
    const r = await runScripted({
      name: 'NEG-05_dsl_illegal_check',
      players: 2,
      stacks: [200, 200],
      hands: [
        {
          // Heads-up: SB acts first preflop. owed = BB - SB blind = 0.5.
          // Scripting SB to check should be flagged.
          preflop: [{ actor: 'SB', action: 'check' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.legalityFailures.length).toBeGreaterThan(0);
    const f = r.legalityFailures[0];
    expect(f.intended.kind).toBe('check');
    expect(f.legalKinds).not.toContain('check');
    expect(f.legalKinds).toContain('fold');
    expect(f.legalKinds).toContain('call');
  });

  it('NEG-06 (DSL): allowIllegalActions=true bypasses oracle (engine sees the bad input)', async () => {
    // Same illegal script, but with allowIllegalActions. Now the engine
    // actually sees the check action while owing chips. The engine
    // should reject it (which surfaces as a strict-mode SimFailure).
    const r = await runScripted({
      name: 'NEG-06_engine_rejects',
      players: 2,
      stacks: [200, 200],
      allowIllegalActions: true,
      hands: [
        {
          preflop: [{ actor: 'SB', action: 'check' }],
        },
      ],
    });
    // r.ok is false because the engine rejected the illegal action
    // (strict mode = HARD failure with SimFailure). legalityFailures
    // should be empty in this mode (oracle was bypassed).
    expect(r.ok).toBe(false);
    expect(r.legalityFailures).toHaveLength(0);
    expect(r.report.endedReason).toBe('error');
    expect(r.report.failure).toBeDefined();
    expect(r.report.failure?.reason).toBe('illegal_action');
  });
});
