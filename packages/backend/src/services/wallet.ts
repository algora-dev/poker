import { ethers } from 'ethers';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

const AUTHORIZATION_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Verify a wallet signature
 */
export function verifySignature(
  message: string,
  signature: string,
  expectedAddress: string
): boolean {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
  } catch (error) {
    logger.error('Signature verification failed', { error });
    return false;
  }
}

/**
 * Generate a message for the user to sign
 */
export function generateDepositMessage(userId: string, walletAddress: string): string {
  const timestamp = Date.now();
  return `I authorize deposits from this wallet to my account.\n\nUser ID: ${userId}\nWallet: ${walletAddress}\nTimestamp: ${timestamp}`;
}

/**
 * Create a deposit authorization
 * Deletes any previous authorizations for the same wallet (security measure)
 */
export async function createDepositAuthorization(
  userId: string,
  walletAddress: string,
  signature: string,
  message: string
) {
  // Verify signature
  const isValid = verifySignature(message, signature, walletAddress);
  if (!isValid) {
    throw new Error('Invalid signature');
  }

  // Delete any existing authorizations for this wallet (across ALL users)
  await prisma.depositAuthorization.deleteMany({
    where: { walletAddress: walletAddress.toLowerCase() },
  });

  // Create new authorization
  const expiresAt = new Date(Date.now() + AUTHORIZATION_DURATION_MS);

  const authorization = await prisma.depositAuthorization.create({
    data: {
      userId,
      walletAddress: walletAddress.toLowerCase(),
      signature,
      message,
      expiresAt,
    },
  });

  logger.info('Deposit authorization created', {
    userId,
    walletAddress: walletAddress.toLowerCase(),
    expiresAt,
  });

  return authorization;
}

/**
 * Find active authorization for a wallet address
 */
export async function findActiveAuthorization(walletAddress: string) {
  const authorization = await prisma.depositAuthorization.findFirst({
    where: {
      walletAddress: walletAddress.toLowerCase(),
      used: false,
      expiresAt: {
        gte: new Date(),
      },
    },
  });

  return authorization;
}

/**
 * Mark authorization as used
 */
export async function markAuthorizationUsed(authorizationId: string) {
  await prisma.depositAuthorization.update({
    where: { id: authorizationId },
    data: {
      used: true,
      usedAt: new Date(),
    },
  });

  logger.info('Deposit authorization marked as used', { authorizationId });
}

/**
 * Clean up expired authorizations (run periodically)
 */
export async function cleanupExpiredAuthorizations() {
  const result = await prisma.depositAuthorization.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });

  if (result.count > 0) {
    logger.info('Cleaned up expired authorizations', { count: result.count });
  }

  return result.count;
}
