/**
 * Anti-cheat phase 2 — RNG + deck-ledger regression (audit-30 I-02).
 *
 * Gerald audit-30 I-02: shuffle uses crypto.randomInt and every hand
 * records a deck commitment hash. This is materially better than many
 * early poker implementations. Keep it covered so no future change
 * silently reintroduces Math.random or drops the commitment.
 *
 * Coverage:
 *   1. deck.ts source file does NOT use Math.random
 *   2. shuffleDeck uses crypto.randomInt (verified by reading source)
 *   3. shuffleDeck produces no positional bias (statistical sanity)
 *   4. buildDeckCommitment is sha256(deckJson) hex
 *   5. buildDeckCommitment is deterministic (same input → same hash)
 *   6. buildDeckCommitment is collision-resistant within a sane input set
 *   7. Different deck orders produce different hashes
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createDeck, shuffleDeck } from '../../src/services/poker/deck';
import { buildDeckCommitment } from '../../src/services/handLedger';

describe('Anti-cheat phase 2 — RNG + deck ledger (audit-30 I-02)', () => {
  // ─── 1 + 2. Source-level guard ─────────────────────────────────
  it('deck.ts source uses crypto.randomInt, NEVER Math.random', () => {
    const path = resolve(
      __dirname,
      '../../src/services/poker/deck.ts'
    );
    const src = readFileSync(path, 'utf8');
    expect(
      src.includes("from 'crypto'") || src.includes('from "crypto"'),
      'deck.ts must import from "crypto"'
    ).toBe(true);
    expect(src.includes('randomInt')).toBe(true);
    // Strip line + block comments so the reminder comment in deck.ts
    // ("Math.random() is NOT suitable for real-money games") doesn't
    // false-trigger the regression check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/.*$/gm, '');          // line comments
    expect(
      /Math\.random\s*\(/.test(code),
      'deck.ts code (outside comments) must NOT use Math.random — crypto.randomInt is required for fairness'
    ).toBe(false);
  });

  // ─── 3. Statistical sanity ─────────────────────────────────────
  it('shuffleDeck has no obvious positional bias over 10k shuffles', () => {
    // For each of the 52 deck positions, count how often each card
    // appears. Uniform shuffle => ~10000/52 ≈ 192 hits per (pos, card).
    // We allow a generous tolerance because we only run 10k shuffles.
    const N = 10_000;
    const deck = createDeck();
    // counts[position][cardKey] = hits
    const counts: Record<number, Record<string, number>> = {};
    for (let i = 0; i < 52; i++) counts[i] = {};

    for (let t = 0; t < N; t++) {
      const shuffled = shuffleDeck(deck);
      for (let i = 0; i < 52; i++) {
        const c = shuffled[i];
        const key = `${c.rank}${c.suit[0]}`;
        counts[i][key] = (counts[i][key] ?? 0) + 1;
      }
    }

    // For every (position, card) pair, the hit count should be within
    // a generous tolerance of the expected uniform mean (192).
    // Tolerance: ±40% accounts for Monte-Carlo noise at N=10k.
    const expected = N / 52;
    const tolerance = expected * 0.4;
    let outliers = 0;
    for (let i = 0; i < 52; i++) {
      for (const key of Object.keys(counts[i])) {
        const hits = counts[i][key];
        if (Math.abs(hits - expected) > tolerance) outliers++;
      }
    }
    // Allow a handful of outliers (statistical noise) but the bulk
    // of (position, card) cells must be in range.
    expect(
      outliers,
      `more than 5% of (position,card) cells exceed ±40% of expected; bias suspected (outliers=${outliers}/${52 * 52})`
    ).toBeLessThan(Math.floor(52 * 52 * 0.05));
  });

  // ─── 4. Hash shape ─────────────────────────────────────────────
  it('buildDeckCommitment returns 64-char hex sha256', async () => {
    const deck = JSON.stringify(createDeck());
    const hash = await buildDeckCommitment(deck);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ─── 5. Deterministic ──────────────────────────────────────────
  it('buildDeckCommitment is deterministic (same input → same hash)', async () => {
    const deck = JSON.stringify(createDeck());
    const h1 = await buildDeckCommitment(deck);
    const h2 = await buildDeckCommitment(deck);
    expect(h1).toBe(h2);
  });

  // ─── 6 + 7. Different inputs → different hashes ────────────────
  it('different shuffles produce different commitments', async () => {
    const N = 100;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) {
      const shuffled = shuffleDeck(createDeck());
      const hash = await buildDeckCommitment(JSON.stringify(shuffled));
      seen.add(hash);
    }
    // 100 shuffles → expect 100 unique hashes (random collision is
    // astronomically unlikely for sha256). Allow ≥99 to account for
    // the extreme outside chance of one duplicate among the shuffle
    // results themselves (52! makes this essentially zero too).
    expect(seen.size).toBeGreaterThanOrEqual(99);
  });
});
