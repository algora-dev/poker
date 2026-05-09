/**
 * Phase 8 [H-04] — Strict signed-challenge deposit authorization
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 8 (secondary option per
 * Shaun: strict signed challenge string, not EIP-712):
 *   - Server-issued nonce, single-use.
 *   - Signed payload binds: userId, wallet, action, nonce, chainId,
 *     contract, issuedAt, expiresAt, amount when applicable.
 *   - Atomic consume on credit; idempotent by txHash.
 *
 * Required test cases:
 *   - valid challenge accepted once
 *   - replay rejected
 *   - expired rejected
 *   - wrong wallet rejected
 *   - wrong user rejected
 *   - duplicate deposit event does not double-credit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

// Stub appLogger.
vi.mock('../../src/services/appLogger', () => ({
  appLog: vi.fn(),
  logError: vi.fn(),
}));

// We do NOT mock prisma at module level here. The wallet service uses
// `prisma` directly for storeDepositAuthorization and findActiveAuthorization.
// We swap a per-test in-memory client through the real prisma export.
vi.mock('../../src/db/client', () => {
  return {
    prisma: new Proxy(
      {},
      {
        get: (_t: any, prop: string) => {
          const harness: any = (globalThis as any).__t3WalletHarness;
          if (!harness) throw new Error('no test harness installed');
          return harness.prisma[prop];
        },
      }
    ),
  };
});

interface AuthRow {
  id: string;
  userId: string;
  walletAddress: string;
  signature: string;
  message: string;
  nonce: string;
  chainId: number;
  contractAddress: string;
  amount: bigint | null;
  issuedAt: Date;
  expiresAt: Date;
  used: boolean;
  usedAt: Date | null;
  createdAt: Date;
}

interface PendingRow {
  id: string;
  userId: string;
  walletAddress: string;
  nonce: string;
  chainId: number;
  contractAddress: string;
  amount: bigint | null;
  issuedAt: Date;
  expiresAt: Date;
  used: boolean;
  usedAt: Date | null;
  createdAt: Date;
}

function buildWalletHarness() {
  const auths: AuthRow[] = [];
  const pending: PendingRow[] = [];
  const prisma: any = {
    pendingDepositChallenge: {
      create: vi.fn(async (args: any) => {
        if (pending.some((p) => p.nonce === args.data.nonce)) {
          const err: any = new Error('Unique constraint failed on nonce');
          err.code = 'P2002';
          throw err;
        }
        const row: PendingRow = {
          id: 'pdc_' + (pending.length + 1),
          userId: args.data.userId,
          walletAddress: args.data.walletAddress,
          nonce: args.data.nonce,
          chainId: args.data.chainId,
          contractAddress: args.data.contractAddress,
          amount: args.data.amount == null ? null : BigInt(args.data.amount),
          issuedAt: args.data.issuedAt ?? new Date(),
          expiresAt: args.data.expiresAt,
          used: false,
          usedAt: null,
          createdAt: new Date(),
        };
        pending.push(row);
        return row;
      }),
      findUnique: vi.fn(async (args: any) =>
        pending.find((p) => p.nonce === args.where.nonce) ?? null
      ),
      updateMany: vi.fn(async (args: any) => {
        const w = args.where;
        let count = 0;
        for (const p of pending) {
          if (w.id && p.id !== w.id) continue;
          if (w.used != null && p.used !== w.used) continue;
          if (args.data.used != null) p.used = args.data.used;
          if (args.data.usedAt != null) p.usedAt = args.data.usedAt;
          count++;
        }
        return { count };
      }),
    },
    depositAuthorization: {
      create: vi.fn(async (args: any) => {
        if (auths.some((a) => a.nonce === args.data.nonce)) {
          // Simulate Postgres unique-constraint violation on nonce.
          const err: any = new Error('Unique constraint failed on nonce');
          err.code = 'P2002';
          throw err;
        }
        const row: AuthRow = {
          id: 'auth_' + (auths.length + 1),
          userId: args.data.userId,
          walletAddress: args.data.walletAddress,
          signature: args.data.signature,
          message: args.data.message,
          nonce: args.data.nonce,
          chainId: args.data.chainId,
          contractAddress: args.data.contractAddress,
          amount: args.data.amount ?? null,
          issuedAt: new Date(args.data.issuedAt),
          expiresAt: new Date(args.data.expiresAt),
          used: false,
          usedAt: null,
          createdAt: new Date(),
        };
        auths.push(row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async (args: any) => auths.find((a) => a.id === args.where.id) ?? null),
      findFirst: vi.fn(async (args: any) => {
        const w = args.where;
        const now = w.expiresAt?.gte ? new Date(w.expiresAt.gte) : new Date();
        const matches = auths.filter((a) => {
          if (w.walletAddress && a.walletAddress !== w.walletAddress) return false;
          if (w.used != null && a.used !== w.used) return false;
          if (w.expiresAt?.gte && a.expiresAt < now) return false;
          if (w.amount !== undefined) {
            if (w.amount === null) {
              if (a.amount !== null) return false;
            } else if (w.amount?.equals != null) {
              if (a.amount !== w.amount.equals) return false;
            }
          }
          return true;
        });
        if (args.orderBy?.issuedAt === 'desc') {
          matches.sort((x, y) => y.issuedAt.getTime() - x.issuedAt.getTime());
        }
        return matches[0] ?? null;
      }),
      updateMany: vi.fn(async (args: any) => {
        const w = args.where;
        let count = 0;
        for (const a of auths) {
          if (w.id && a.id !== w.id) continue;
          if (w.used != null && a.used !== w.used) continue;
          if (w.expiresAt?.gte && a.expiresAt < new Date(w.expiresAt.gte)) continue;
          if (args.data.used != null) a.used = args.data.used;
          if (args.data.usedAt != null) a.usedAt = args.data.usedAt;
          count++;
        }
        return { count };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { prisma, auths, pending };
}

function makeWallet() {
  return ethers.Wallet.createRandom();
}

describe('Phase 8 [H-04] — strict signed-challenge deposit authorization', () => {
  let mod: typeof import('../../src/services/wallet');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/wallet');
    (globalThis as any).__t3WalletHarness = buildWalletHarness();
  });

  it('valid challenge is accepted once', async () => {
    const wallet = makeWallet();
    const userId = 'u1';
    const challenge = await mod.createDepositChallenge({
      userId,
      walletAddress: wallet.address,
      amount: 1_000_000n,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);

    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(true);
    expect((globalThis as any).__t3WalletHarness.auths.length).toBe(1);
  });

  it('replay (same nonce) is rejected with code "replay"', async () => {
    const wallet = makeWallet();
    const userId = 'u1';
    const challenge = await mod.createDepositChallenge({
      userId,
      walletAddress: wallet.address,
      amount: 1_000_000n,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);

    const ctx = {
      userId,
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    };
    const first = await mod.storeDepositAuthorization(ctx);
    expect(first.ok).toBe(true);

    const second = await mod.storeDepositAuthorization(ctx);
    expect(second.ok).toBe(false);
    if (second.ok === false) expect(second.code).toBe('replay');
  });

  it('expired challenge is rejected with code "expired"', async () => {
    const wallet = makeWallet();
    const userId = 'u1';
    // issuedAt 1 hour ago -> expiresAt is also in the past
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const challenge = await mod.createDepositChallenge({
      userId,
      walletAddress: wallet.address,
      amount: null,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
      now: oneHourAgo,
    });
    const signature = await wallet.signMessage(challenge.challenge);

    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('expired');
  });

  it('wrong wallet rejected (signature for one wallet, posted as another)', async () => {
    const realWallet = makeWallet();
    const decoyWallet = makeWallet();
    const userId = 'u1';
    const challenge = await mod.createDepositChallenge({
      userId,
      walletAddress: realWallet.address,
      amount: null,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await realWallet.signMessage(challenge.challenge);

    // Caller claims a different wallet address.
    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: decoyWallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // Wallet binding inside the challenge string does not match the
      // caller's claimed wallet -> wallet_mismatch.
      expect(result.code).toBe('wallet_mismatch');
    }
  });

  it('wrong user rejected (caller userId differs from challenge userId)', async () => {
    const wallet = makeWallet();
    const challenge = await mod.createDepositChallenge({
      userId: 'u_alice',
      walletAddress: wallet.address,
      amount: null,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);

    const result = await mod.storeDepositAuthorization({
      userId: 'u_bob', // not who the challenge was issued for
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('user_mismatch');
  });

  it('chainId mismatch rejected (replay across chains)', async () => {
    const wallet = makeWallet();
    const challenge = await mod.createDepositChallenge({
      userId: 'u1',
      walletAddress: wallet.address,
      amount: null,
      chainId: 1, // mainnet
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);

    const result = await mod.storeDepositAuthorization({
      userId: 'u1',
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337, // server expects testnet
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('chain_mismatch');
  });

  it('contract mismatch rejected (signature targets a different contract)', async () => {
    const wallet = makeWallet();
    const challenge = await mod.createDepositChallenge({
      userId: 'u1',
      walletAddress: wallet.address,
      amount: null,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000aaaa',
    });
    const signature = await wallet.signMessage(challenge.challenge);

    const result = await mod.storeDepositAuthorization({
      userId: 'u1',
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000bbbb',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('contract_mismatch');
  });

  it('tampered message rejected (signature does not match modified challenge)', async () => {
    const wallet = makeWallet();
    const challenge = await mod.createDepositChallenge({
      userId: 'u1',
      walletAddress: wallet.address,
      amount: 1_000_000n,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);

    // Attacker tries to bump the amount line in the message they post back.
    const tampered = challenge.challenge.replace(
      'amount: 1000000',
      'amount: 999999999'
    );

    const result = await mod.storeDepositAuthorization({
      userId: 'u1',
      walletAddress: wallet.address,
      message: tampered,
      signature, // original signature against pre-tamper bytes
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('invalid_signature');
  });

  it('malformed challenge (not our format) rejected without DB write', async () => {
    const wallet = makeWallet();
    const message = 'I will pay you 100 chips, signed yours truly';
    const signature = await wallet.signMessage(message);

    const result = await mod.storeDepositAuthorization({
      userId: 'u1',
      walletAddress: wallet.address,
      message,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('malformed_challenge');
    expect((globalThis as any).__t3WalletHarness.auths.length).toBe(0);
  });
});

describe('Phase 8 [H-04] — consumeAuthorization (atomic single-use)', () => {
  let mod: typeof import('../../src/services/wallet');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/wallet');
    (globalThis as any).__t3WalletHarness = buildWalletHarness();
  });

  it('first consume succeeds, second consume returns false (idempotent)', async () => {
    // Seed an authorization directly.
    const wallet = makeWallet();
    const challenge = await mod.createDepositChallenge({
      userId: 'u1',
      walletAddress: wallet.address,
      amount: 1_000_000n,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);
    const stored = await mod.storeDepositAuthorization({
      userId: 'u1',
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    if (stored.ok !== true) throw new Error('seed failed');

    const harness: any = (globalThis as any).__t3WalletHarness;
    const tx = harness.prisma; // model methods include updateMany

    const first = await mod.consumeAuthorization(tx, stored.id);
    expect(first).toBe(true);

    const second = await mod.consumeAuthorization(tx, stored.id);
    expect(second).toBe(false);

    // The row is now marked used.
    expect(harness.auths[0].used).toBe(true);
    expect(harness.auths[0].usedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 follow-up [item 2]: server-issued challenges with strict TTL gates.
// ---------------------------------------------------------------------------

describe('Phase 9 follow-up [item 2] — server-issued challenges + TTL gates', () => {
  let mod: typeof import('../../src/services/wallet');
  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/services/wallet');
    (globalThis as any).__t3WalletHarness = buildWalletHarness();
  });

  it('forged client-generated nonce (no server pending row) rejected with code unknown_challenge', async () => {
    // Attacker constructs a perfectly-formatted canonical challenge with a
    // nonce the server NEVER issued, signs it with a real wallet, and posts.
    const wallet = makeWallet();
    const userId = 'u_attacker';
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 9 * 60 * 1000);
    const forgedNonce = 'ff'.repeat(32); // not from the server
    const message = mod.buildDepositChallenge({
      userId,
      walletAddress: wallet.address,
      nonce: forgedNonce,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
      amount: 1_000_000n,
      issuedAt,
      expiresAt,
    });
    const signature = await wallet.signMessage(message);

    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: wallet.address,
      message,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('unknown_challenge');
  });

  it('far-future expiry (TTL > 10min + skew) rejected with code ttl_exceeded', async () => {
    const wallet = makeWallet();
    const userId = 'u1';
    const issuedAt = new Date();
    // expiresAt is 24 hours in the future — way beyond the 10-minute cap.
    const expiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000);
    const message = mod.buildDepositChallenge({
      userId,
      walletAddress: wallet.address,
      nonce: 'ab'.repeat(32),
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
      amount: null,
      issuedAt,
      expiresAt,
    });
    const signature = await wallet.signMessage(message);

    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: wallet.address,
      message,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('ttl_exceeded');
  });

  it('future-issued challenge (issuedAt > now + skew) rejected with code issued_in_future', async () => {
    const wallet = makeWallet();
    const userId = 'u1';
    // issuedAt 5 minutes in the future.
    const issuedAt = new Date(Date.now() + 5 * 60 * 1000);
    const expiresAt = new Date(issuedAt.getTime() + 9 * 60 * 1000);
    const message = mod.buildDepositChallenge({
      userId,
      walletAddress: wallet.address,
      nonce: 'cd'.repeat(32),
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
      amount: null,
      issuedAt,
      expiresAt,
    });
    const signature = await wallet.signMessage(message);

    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: wallet.address,
      message,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('issued_in_future');
  });

  it('valid server-issued challenge accepted (full happy path through createDepositChallenge)', async () => {
    const wallet = makeWallet();
    const userId = 'u1';
    const challenge = await mod.createDepositChallenge({
      userId,
      walletAddress: wallet.address,
      amount: 1_000_000n,
      chainId: 31337,
      contractAddress: '0x000000000000000000000000000000000000beef',
    });
    const signature = await wallet.signMessage(challenge.challenge);
    const result = await mod.storeDepositAuthorization({
      userId,
      walletAddress: wallet.address,
      message: challenge.challenge,
      signature,
      expectedChainId: 31337,
      expectedContractAddress: '0x000000000000000000000000000000000000beef',
    });
    expect(result.ok).toBe(true);
    // Pending row was marked used.
    const harness: any = (globalThis as any).__t3WalletHarness;
    expect(harness.pending.length).toBe(1);
    expect(harness.pending[0].used).toBe(true);
  });
});
