import { prisma } from '../db/client';
import { Wallet, Contract, JsonRpcProvider, parseUnits } from 'ethers';
import { CONFIG } from '../config';
import { logger } from '../utils/logger';
import { emitBalanceUpdate } from '../socket';
import { recordMoneyEvent } from './moneyLedger';

const VAULT_ABI = [
  'function completeWithdrawal(address user, uint256 amount) external',
  'function pendingWithdrawals(address user) view returns (uint256)',
];

/**
 * Process a withdrawal request.
 * CRITICAL: This moves real money. Every step must be audited.
 *
 * Flow:
 * 1. Validate user has enough chips
 * 2. Deduct chips from balance (lock them)
 * 3. Create withdrawal record (status: pending)
 * 4. Call smart contract completeWithdrawal
 * 5. Update withdrawal status (completed/failed)
 * 6. If failed, refund chips
 */
export async function processWithdrawal(
  userId: string,
  amount: number
): Promise<{ withdrawalId: string; txHash?: string; status: string }> {
  const amountBigInt = BigInt(Math.floor(amount * 1_000_000));

  // Validate minimum
  if (amountBigInt < BigInt(1_000_000)) {
    throw new Error('Minimum withdrawal is 1.00 mUSD');
  }

  // Get user's wallet address
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { chipBalance: true },
  });

  if (!user) throw new Error('User not found');
  if (!user.walletAddress) throw new Error('No wallet connected. Please connect a wallet first.');
  if (!user.chipBalance) throw new Error('No chip balance found');

  // Validate balance
  if (user.chipBalance.chips < amountBigInt) {
    const available = (Number(user.chipBalance.chips) / 1_000_000).toFixed(2);
    throw new Error(`Insufficient chips. Available: ${available}`);
  }

  // Check user isn't in an active game
  const activeGame = await prisma.gamePlayer.findFirst({
    where: {
      userId,
      game: { status: 'in_progress' },
    },
  });

  if (activeGame) {
    throw new Error('Cannot withdraw while in an active game. Leave the table first.');
  }

  // Check no pending withdrawal exists
  const pendingWithdrawal = await prisma.withdrawal.findFirst({
    where: {
      userId,
      status: 'pending',
    },
  });

  if (pendingWithdrawal) {
    throw new Error('You have a pending withdrawal. Please wait for it to complete.');
  }

  // Step 1: Deduct chips and create withdrawal record atomically
  const { withdrawal, balanceBefore } = await prisma.$transaction(async (tx) => {
    const balance = await tx.chipBalance.findUnique({
      where: { userId },
    });

    if (!balance || balance.chips < amountBigInt) {
      throw new Error('Insufficient chips');
    }

    const newBalance = await tx.chipBalance.update({
      where: { userId },
      data: { chips: { decrement: amountBigInt } },
    });

    const withdrawal = await tx.withdrawal.create({
      data: {
        userId,
        amount: amountBigInt,
        status: 'pending',
      },
    });

    await tx.chipAudit.create({
      data: {
        userId,
        operation: 'withdrawal',
        amountDelta: -amountBigInt,
        balanceBefore: balance.chips,
        balanceAfter: newBalance.chips,
        reference: withdrawal.id,
        notes: `Withdrawal of ${amount.toFixed(2)} mUSD to ${user.walletAddress}`,
      },
    });

    // Phase 9 follow-up [item 3]: ledger event for withdrawal request.
    await recordMoneyEvent(tx as any, {
      userId,
      eventType: 'withdrawal_requested',
      amount: -amountBigInt,
      balanceBefore: balance.chips,
      balanceAfter: newBalance.chips,
      withdrawalId: withdrawal.id,
      correlationId: `withdrawal:${withdrawal.id}`,
      payload: {
        wallet: user.walletAddress,
        amountMicro: amountBigInt.toString(),
      },
    });

    logger.info('Withdrawal created — chips deducted', {
      withdrawalId: withdrawal.id,
      userId,
      amount: amountBigInt.toString(),
      wallet: user.walletAddress,
    });

    return { withdrawal, balanceBefore: balance.chips };
  });

  // Emit balance update immediately
  const updatedBalance = await prisma.chipBalance.findUnique({ where: { userId } });
  if (updatedBalance) {
    emitBalanceUpdate(userId, updatedBalance.chips.toString());
  }

  // Step 2: Call smart contract
  try {
    const provider = new JsonRpcProvider(CONFIG.RPC_URL);
    const wallet = new Wallet(CONFIG.PRIVATE_KEY, provider);
    const vault = new Contract(CONFIG.CONTRACT_ADDRESS, VAULT_ABI, wallet);

    logger.info('Sending withdrawal transaction', {
      withdrawalId: withdrawal.id,
      to: user.walletAddress,
      amount: amountBigInt.toString(),
    });

    const tx = await vault.completeWithdrawal(user.walletAddress, amountBigInt);
    
    logger.info('Withdrawal TX submitted', {
      withdrawalId: withdrawal.id,
      txHash: tx.hash,
    });

    // Update with tx hash
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        txHash: tx.hash,
        status: 'submitted',
      },
    });

    // Wait for confirmation
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      // Success
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });
      // Phase 9 follow-up [item 3]: ledger event for completion.
      await recordMoneyEvent(prisma as any, {
        userId,
        eventType: 'withdrawal_completed',
        amount: 0n,
        withdrawalId: withdrawal.id,
        txHash: tx.hash,
        correlationId: `withdrawal:${withdrawal.id}`,
        payload: { blockNumber: receipt.blockNumber },
      });

      logger.info('Withdrawal completed', {
        withdrawalId: withdrawal.id,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });

      return {
        withdrawalId: withdrawal.id,
        txHash: tx.hash,
        status: 'completed',
      };
    } else {
      // TX reverted — refund
      throw new Error('Transaction reverted');
    }
  } catch (error: any) {
    logger.error('Withdrawal failed — refunding chips', {
      withdrawalId: withdrawal.id,
      error: error.message,
    });

    // Refund chips
    await prisma.$transaction(async (tx) => {
      await tx.chipBalance.update({
        where: { userId },
        data: { chips: { increment: amountBigInt } },
      });

      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'failed' },
      });

      await tx.chipAudit.create({
        data: {
          userId,
          operation: 'withdrawal_refund',
          amountDelta: amountBigInt,
          balanceBefore: balanceBefore - amountBigInt,
          balanceAfter: balanceBefore,
          reference: withdrawal.id,
          notes: `Withdrawal failed — refunded. Error: ${error.message}`,
        },
      });
      // Phase 9 follow-up [item 3]: ledger events for failure + refund.
      await recordMoneyEvent(tx as any, {
        userId,
        eventType: 'withdrawal_failed',
        amount: 0n,
        withdrawalId: withdrawal.id,
        correlationId: `withdrawal:${withdrawal.id}`,
        payload: { error: String(error?.message ?? error) },
      });
      await recordMoneyEvent(tx as any, {
        userId,
        eventType: 'withdrawal_refund',
        amount: amountBigInt,
        balanceBefore: balanceBefore - amountBigInt,
        balanceAfter: balanceBefore,
        withdrawalId: withdrawal.id,
        correlationId: `withdrawal:${withdrawal.id}`,
      });
    });

    // Re-emit correct balance
    const refundedBalance = await prisma.chipBalance.findUnique({ where: { userId } });
    if (refundedBalance) {
      emitBalanceUpdate(userId, refundedBalance.chips.toString());
    }

    throw new Error(`Withdrawal failed: ${error.message}. Your chips have been refunded.`);
  }
}

/**
 * Get withdrawal history for a user
 */
export async function getWithdrawalHistory(userId: string) {
  return await prisma.withdrawal.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take: 20,
  });
}
