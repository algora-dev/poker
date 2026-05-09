/**
 * Phase 8 [H-04] — Strict signed-challenge deposit authorization.
 *
 * Per audits/t3-poker/06-dave-fix-prompt.md Phase 8:
 *   - Server-issued one-time nonce.
 *   - Signed payload binds: userId, walletAddress, action, nonce, chainId,
 *     contractAddress, issuedAt, expiresAt, and amount when applicable.
 *   - Nonce stored server-side and marked used atomically when a deposit is
 *     credited.
 *   - Deposit crediting is idempotent by transaction hash.
 *
 * This module implements the SECONDARY option from the audit (a strict
 * structured signed challenge string) rather than EIP-712, per Shaun's
 * direction. The challenge string format below is the canonical thing the
 * user signs; any deviation invalidates the signature.
 */

import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';

const AUTHORIZATION_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Server-side TTL hard cap. Even if a row were ever inserted with a longer
 * expiry, storeDepositAuthorization() refuses to accept any challenge whose
 * expiresAt is more than this far past issuedAt.
 */
const MAX_CHALLENGE_TTL_MS = AUTHORIZATION_DURATION_MS;

/**
 * Allowed clock skew between server time and signed timestamps. Defends
 * against future-dated forgeries while tolerating normal rounding.
 */
const MAX_CLOCK_SKEW_MS = 30 * 1000; // 30 seconds

/**
 * Action label baked into every challenge so the same signature cannot be
 * replayed against a different intent.
 */
const ACTION_DEPOSIT = 'deposit_authorize';

/**
 * Build the canonical challenge string. The exact format and field order
 * matters: the client must sign this byte-for-byte. Any change here is a
 * breaking change for clients.
 *
 * Lines are separated by '\n'. amount may be null/undefined to indicate a
 * wallet-bound (not amount-bound) authorization.
 */
export function buildDepositChallenge(input: {
  userId: string;
  walletAddress: string;
  nonce: string;
  chainId: number;
  contractAddress: string;
  amount: bigint | null;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const lines = [
    `T3 Poker deposit authorization`,
    `action: ${ACTION_DEPOSIT}`,
    `userId: ${input.userId}`,
    `wallet: ${input.walletAddress.toLowerCase()}`,
    `nonce: ${input.nonce}`,
    `chainId: ${input.chainId}`,
    `contract: ${input.contractAddress.toLowerCase()}`,
    `amount: ${input.amount == null ? 'any' : input.amount.toString()}`,
    `issuedAt: ${input.issuedAt.toISOString()}`,
    `expiresAt: ${input.expiresAt.toISOString()}`,
  ];
  return lines.join('\n');
}

/**
 * Generate a fresh server-side nonce. 32 bytes hex = 64 chars. Crypto-strong.
 */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Step 1 of the flow. The client calls this BEFORE signing.
 *
 * Phase 9 follow-up [item 2]: server-issued challenges are now persisted
 * IMMEDIATELY in PendingDepositChallenge. The signed-submit step REQUIRES
 * a matching server-side row, so a client cannot forge a canonical
 * challenge with an arbitrary nonce or far-future expiry.
 */
export async function createDepositChallenge(input: {
  userId: string;
  walletAddress: string;
  amount?: bigint | null;
  chainId?: number;
  contractAddress?: string;
  now?: Date;
}): Promise<{
  challenge: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  chainId: number;
  contractAddress: string;
  amount: bigint | null;
}> {
  if (!input.userId) throw new Error('userId required');
  if (!ethers.isAddress(input.walletAddress)) {
    throw new Error('Invalid wallet address');
  }
  const now = input.now ?? new Date();
  const nonce = generateNonce();
  const chainId = input.chainId ?? Number(CONFIG.CHAIN_ID);
  const contractAddress = (input.contractAddress ?? CONFIG.CONTRACT_ADDRESS).toLowerCase();
  const amount = input.amount == null ? null : BigInt(input.amount);
  const issuedAt = now;
  const expiresAt = new Date(now.getTime() + AUTHORIZATION_DURATION_MS);
  const wallet = input.walletAddress.toLowerCase();

  // Persist BEFORE returning to the client. From this point on, the only
  // acceptable signed submit is one whose challenge matches a stored row.
  await prisma.pendingDepositChallenge.create({
    data: {
      userId: input.userId,
      walletAddress: wallet,
      nonce,
      chainId,
      contractAddress,
      amount,
      issuedAt,
      expiresAt,
    },
  });

  const challenge = buildDepositChallenge({
    userId: input.userId,
    walletAddress: input.walletAddress,
    nonce,
    chainId,
    contractAddress,
    amount,
    issuedAt,
    expiresAt,
  });
  logger.info('Deposit challenge issued', {
    userId: input.userId,
    wallet,
    nonce,
    chainId,
    expiresAt: expiresAt.toISOString(),
  });
  return { challenge, nonce, issuedAt, expiresAt, chainId, contractAddress, amount };
}

/**
 * Verify a wallet signature over the EXACT challenge string.
 */
export function verifySignature(
  message: string,
  signature: string,
  expectedAddress: string
): boolean {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch (error) {
    logger.error('Signature verification failed', { error: (error as Error).message });
    return false;
  }
}

/**
 * Parse a challenge string back into its bound fields. Returns null if the
 * string does not match the canonical format. We re-derive the fields from
 * the supplied message (rather than trusting client-supplied JSON) so we can
 * verify the signature is bound to a specific intent.
 */
export function parseDepositChallenge(message: string): null | {
  action: string;
  userId: string;
  walletAddress: string;
  nonce: string;
  chainId: number;
  contractAddress: string;
  amount: bigint | null;
  issuedAt: Date;
  expiresAt: Date;
} {
  const lines = message.split('\n');
  if (lines[0] !== 'T3 Poker deposit authorization') return null;
  const map = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(': ');
    if (idx < 0) return null;
    map.set(lines[i].slice(0, idx), lines[i].slice(idx + 2));
  }
  try {
    const action = map.get('action');
    const userId = map.get('userId');
    const walletAddress = map.get('wallet');
    const nonce = map.get('nonce');
    const chainStr = map.get('chainId');
    const contractAddress = map.get('contract');
    const amountStr = map.get('amount');
    const issuedAtStr = map.get('issuedAt');
    const expiresAtStr = map.get('expiresAt');
    if (
      !action ||
      !userId ||
      !walletAddress ||
      !nonce ||
      !chainStr ||
      !contractAddress ||
      !amountStr ||
      !issuedAtStr ||
      !expiresAtStr
    ) {
      return null;
    }
    return {
      action,
      userId,
      walletAddress,
      nonce,
      chainId: Number(chainStr),
      contractAddress,
      amount: amountStr === 'any' ? null : BigInt(amountStr),
      issuedAt: new Date(issuedAtStr),
      expiresAt: new Date(expiresAtStr),
    };
  } catch {
    return null;
  }
}

export type StoreAuthorizationResult =
  | { ok: true; id: string }
  | {
      ok: false;
      code:
        | 'malformed_challenge'
        | 'wrong_action'
        | 'user_mismatch'
        | 'wallet_mismatch'
        | 'chain_mismatch'
        | 'contract_mismatch'
        | 'expired'
        | 'invalid_signature'
        | 'replay'
        // Phase 9 follow-up [item 2]
        | 'unknown_challenge'
        | 'ttl_exceeded'
        | 'issued_in_future'
        | 'binding_mismatch';
      message: string;
    };

/**
 * Step 2 of the flow. Client returns the EXACT challenge string + signature.
 * We re-validate every binding field against the server's expected context
 * so a signature for one intent cannot be replayed against another.
 */
export async function storeDepositAuthorization(input: {
  userId: string;
  walletAddress: string;
  message: string;
  signature: string;
  // Server-side context for binding checks.
  expectedChainId?: number;
  expectedContractAddress?: string;
  // Optional clock override (tests).
  now?: Date;
}): Promise<StoreAuthorizationResult> {
  const parsed = parseDepositChallenge(input.message);
  if (!parsed) {
    return { ok: false, code: 'malformed_challenge', message: 'Challenge string is malformed' };
  }
  if (parsed.action !== ACTION_DEPOSIT) {
    return { ok: false, code: 'wrong_action', message: 'Wrong action in challenge' };
  }
  if (parsed.userId !== input.userId) {
    return { ok: false, code: 'user_mismatch', message: 'Challenge user does not match caller' };
  }
  if (parsed.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return { ok: false, code: 'wallet_mismatch', message: 'Challenge wallet does not match' };
  }
  const expectedChainId = input.expectedChainId ?? Number(CONFIG.CHAIN_ID);
  if (parsed.chainId !== expectedChainId) {
    return { ok: false, code: 'chain_mismatch', message: 'Challenge chainId does not match' };
  }
  const expectedContract = (input.expectedContractAddress ?? CONFIG.CONTRACT_ADDRESS).toLowerCase();
  if (parsed.contractAddress.toLowerCase() !== expectedContract) {
    return { ok: false, code: 'contract_mismatch', message: 'Challenge contract does not match' };
  }
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (parsed.expiresAt.getTime() < nowMs) {
    return { ok: false, code: 'expired', message: 'Challenge has expired' };
  }
  // Phase 9 follow-up [item 2]: cap TTL and reject future-dated issuedAt.
  if (parsed.issuedAt.getTime() > nowMs + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      code: 'issued_in_future',
      message: 'Challenge issuedAt is in the future',
    };
  }
  if (
    parsed.expiresAt.getTime() >
    parsed.issuedAt.getTime() + MAX_CHALLENGE_TTL_MS + MAX_CLOCK_SKEW_MS
  ) {
    return {
      ok: false,
      code: 'ttl_exceeded',
      message: 'Challenge expiresAt exceeds maximum allowed TTL',
    };
  }

  if (!verifySignature(input.message, input.signature, input.walletAddress)) {
    return { ok: false, code: 'invalid_signature', message: 'Invalid signature' };
  }

  // Phase 9 follow-up [item 2]: require a server-issued pending row.
  // Any challenge whose nonce was not generated by this server is rejected.
  let pendingFound: any = null;
  try {
    pendingFound = await prisma.pendingDepositChallenge.findUnique({
      where: { nonce: parsed.nonce },
    });
  } catch {
    pendingFound = null;
  }
  if (!pendingFound) {
    return {
      ok: false,
      code: 'unknown_challenge',
      message: 'Nonce was not issued by this server',
    };
  }
  if (pendingFound.used) {
    return { ok: false, code: 'replay', message: 'Nonce already used' };
  }
  // Re-validate every binding against the persisted row.
  if (
    pendingFound.userId !== parsed.userId ||
    pendingFound.walletAddress.toLowerCase() !== parsed.walletAddress.toLowerCase() ||
    pendingFound.chainId !== parsed.chainId ||
    pendingFound.contractAddress.toLowerCase() !== parsed.contractAddress.toLowerCase()
  ) {
    return {
      ok: false,
      code: 'binding_mismatch',
      message: 'Challenge bindings differ from server-issued row',
    };
  }
  const pendingAmount: bigint | null =
    pendingFound.amount == null ? null : BigInt(pendingFound.amount);
  if (pendingAmount === null ? parsed.amount !== null : parsed.amount !== pendingAmount) {
    return {
      ok: false,
      code: 'binding_mismatch',
      message: 'Challenge amount differs from server-issued row',
    };
  }
  if (
    Math.abs(pendingFound.issuedAt.getTime() - parsed.issuedAt.getTime()) >
      MAX_CLOCK_SKEW_MS ||
    Math.abs(pendingFound.expiresAt.getTime() - parsed.expiresAt.getTime()) >
      MAX_CLOCK_SKEW_MS
  ) {
    return {
      ok: false,
      code: 'binding_mismatch',
      message: 'Challenge timestamps differ from server-issued row',
    };
  }

  // Atomically claim the pending row. Loser of a race sees count=0 -> replay.
  const claim = await prisma.pendingDepositChallenge.updateMany({
    where: { id: pendingFound.id, used: false },
    data: { used: true, usedAt: now },
  });
  if (claim.count !== 1) {
    return { ok: false, code: 'replay', message: 'Nonce already used' };
  }

  try {
    const created = await prisma.depositAuthorization.create({
      data: {
        userId: parsed.userId,
        walletAddress: parsed.walletAddress.toLowerCase(),
        signature: input.signature,
        message: input.message,
        nonce: parsed.nonce,
        chainId: parsed.chainId,
        contractAddress: parsed.contractAddress.toLowerCase(),
        amount: parsed.amount,
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
      },
      select: { id: true },
    });
    logger.info('Deposit authorization stored', {
      id: created.id,
      userId: parsed.userId,
      wallet: parsed.walletAddress,
      nonce: parsed.nonce,
      chainId: parsed.chainId,
      expiresAt: parsed.expiresAt.toISOString(),
    });
    return { ok: true, id: created.id };
  } catch (err: any) {
    if (err?.code === 'P2002' || /Unique constraint/i.test(err?.message ?? '')) {
      logger.warn('Deposit authorization replay attempt', {
        userId: parsed.userId,
        wallet: parsed.walletAddress,
        nonce: parsed.nonce,
      });
      return { ok: false, code: 'replay', message: 'Nonce already used' };
    }
    throw err;
  }
}

/**
 * Find an active authorization for a wallet that has not expired and has
 * not been used. Used by the deposit listener.
 *
 * If `amount` is provided, prefer authorizations with a matching amount
 * binding (or null = any). If no amount-bound match exists, fall back to a
 * wallet-bound (amount=null) auth if present.
 */
export async function findActiveAuthorization(
  walletAddress: string,
  amount?: bigint
) {
  const now = new Date();
  const wallet = walletAddress.toLowerCase();

  if (amount != null) {
    // Prefer the most recent matching amount-bound auth.
    const matching = await prisma.depositAuthorization.findFirst({
      where: {
        walletAddress: wallet,
        used: false,
        expiresAt: { gte: now },
        amount: { equals: amount },
      },
      orderBy: { issuedAt: 'desc' },
    });
    if (matching) return matching;
  }

  // Fall back to wallet-bound (amount=null) auth.
  return prisma.depositAuthorization.findFirst({
    where: {
      walletAddress: wallet,
      used: false,
      expiresAt: { gte: now },
      amount: null,
    },
    orderBy: { issuedAt: 'desc' },
  });
}

/**
 * Atomically mark an authorization as used. Returns true if THIS call
 * marked it (count=1) and false if it was already used by a concurrent
 * request (count=0). Use the returned boolean to decide whether to credit.
 *
 * Caller passes a Prisma transaction client so this consume happens in the
 * same tx as the chip credit.
 */
export async function consumeAuthorization(
  tx: { depositAuthorization: { updateMany: (args: any) => Promise<{ count: number }> } },
  authorizationId: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await tx.depositAuthorization.updateMany({
    where: { id: authorizationId, used: false, expiresAt: { gte: now } },
    data: { used: true, usedAt: now },
  });
  return result.count === 1;
}

/**
 * Clean up expired authorizations (run periodically).
 */
export async function cleanupExpiredAuthorizations() {
  const result = await prisma.depositAuthorization.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (result.count > 0) {
    logger.info('Cleaned up expired authorizations', { count: result.count });
  }
  return result.count;
}

// ---------------------------------------------------------------------------
// Backward-compat exports (referenced elsewhere in the codebase).
// ---------------------------------------------------------------------------

/**
 * @deprecated Use createDepositChallenge() + storeDepositAuthorization()
 *             instead. This entry point is kept temporarily so upstream
 *             callers compile while the API surface is migrated.
 */
export async function generateDepositMessage(
  userId: string,
  walletAddress: string
): Promise<string> {
  const c = await createDepositChallenge({ userId, walletAddress });
  return c.challenge;
}

/**
 * @deprecated Use storeDepositAuthorization(). This wrapper accepts the
 *             pre-Phase-8 (userId, walletAddress, signature, message) shape
 *             and routes it through the strict path.
 */
export async function createDepositAuthorization(
  userId: string,
  walletAddress: string,
  signature: string,
  message: string
) {
  const result = await storeDepositAuthorization({
    userId,
    walletAddress,
    signature,
    message,
  });
  if (result.ok !== true) {
    throw new Error(`deposit_auth_rejected:${result.code}`);
  }
  return prisma.depositAuthorization.findUnique({ where: { id: result.id } });
}

/**
 * @deprecated Use consumeAuthorization() inside the credit transaction.
 */
export async function markAuthorizationUsed(authorizationId: string) {
  await prisma.depositAuthorization.update({
    where: { id: authorizationId },
    data: { used: true, usedAt: new Date() },
  });
  logger.info('Deposit authorization marked as used', { authorizationId });
}
