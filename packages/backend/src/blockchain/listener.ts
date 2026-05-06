import { ethers } from 'ethers';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';
import { findActiveAuthorization, consumeAuthorization } from '../services/wallet';
import { emitBalanceUpdate } from '../socket';
import { recordMoneyEvent } from '../services/moneyLedger';

const VAULT_ABI = [
  'event Deposit(address indexed user, uint256 amount, uint256 timestamp, uint256 blockNumber)',
  'function getTotalBalance() view returns (uint256)',
];

let provider: ethers.Provider;
let vault: ethers.Contract;
let isListening = false;

/**
 * Initialize blockchain connection
 */
export function initializeBlockchain() {
  provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  vault = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, VAULT_ABI, provider);
  logger.info('Blockchain connection initialized', {
    network: CONFIG.CHAIN_ID,
    contract: CONFIG.CONTRACT_ADDRESS,
  });
}

/**
 * Credit chips to user when deposit is confirmed
 */
async function creditChips(
  userAddress: string,
  amount: bigint,
  txHash: string,
  blockNumber: number
) {
  try {
    // Phase 8 [H-04]: prefer an authorization that's bound to the exact
    // amount, falling back to a wallet-bound (amount=null) auth.
    const authorization = await findActiveAuthorization(userAddress, amount);
    if (!authorization) {
      logger.warn('Deposit attempted without active authorization', {
        walletAddress: userAddress,
        txHash,
        amount: amount.toString(),
      });
      // TODO: Add to pending deposits table for manual review
      return;
    }

    // Convert mUSD to chips (1:1 ratio, both use 6 decimals)
    const chips = amount;

    // Phase 8 [H-04]: idempotent crediting by txHash + atomic auth consume.
    // The Deposit table's unique txHash + `tx.deposit.create` will throw on
    // duplicate, and `consumeAuthorization` returns false if the row was
    // already consumed by a concurrent request — either way, no double-credit.
    let alreadyProcessed = false;
    let creditedNewBalance: string | null = null;
    let creditedUserId: string | null = null;
    await prisma.$transaction(async (tx) => {
      // Idempotency check: txHash already credited?
      const existing = await tx.deposit.findUnique({ where: { txHash } });
      if (existing) {
        alreadyProcessed = true;
        return;
      }

      // Atomic auth consume: returns false if another concurrent request
      // already consumed the authorization, in which case we abort.
      const claimed = await consumeAuthorization(tx as any, authorization.id);
      if (!claimed) {
        logger.warn('Authorization already consumed by concurrent request', {
          authorizationId: authorization.id,
          txHash,
        });
        alreadyProcessed = true;
        return;
      }

      const user = await tx.user.findUnique({ where: { id: authorization.userId } });
      if (!user) {
        throw new Error('user_not_found_for_authorized_deposit');
      }

      const chipBalance = await tx.chipBalance.upsert({
        where: { userId: user.id },
        create: { userId: user.id, chips },
        update: { chips: { increment: chips } },
      });

      await tx.deposit.create({
        data: {
          userId: user.id,
          amount,
          txHash,
          blockNumber,
          confirmed: true,
        },
      });

      await tx.chipAudit.create({
        data: {
          userId: user.id,
          operation: 'deposit',
          amountDelta: chips,
          balanceBefore: chipBalance.chips - chips,
          balanceAfter: chipBalance.chips,
          reference: txHash,
          notes: `Deposit from blockchain tx ${txHash}`,
        },
      });

      // Phase 9 follow-up [item 3]: deposits land in the dedicated
      // off-table MoneyEvent ledger (no Game FK), not in HandEvent.
      await recordMoneyEvent(tx as any, {
        userId: user.id,
        eventType: 'deposit',
        amount: chips,
        balanceBefore: chipBalance.chips - chips,
        balanceAfter: chipBalance.chips,
        txHash,
        authorizationId: authorization.id,
        correlationId: txHash,
        payload: {
          blockNumber,
          walletAddress: userAddress.toLowerCase(),
          nonce: authorization.nonce,
        },
      });

      creditedNewBalance = chipBalance.chips.toString();
      creditedUserId = user.id;
    });

    if (alreadyProcessed) return;
    if (creditedUserId && creditedNewBalance) {
      logger.info('Chips credited successfully', {
        userId: creditedUserId,
        walletAddress: userAddress,
        amount: amount.toString(),
        chips: chips.toString(),
        txHash,
        blockNumber,
        newBalance: creditedNewBalance,
      });
      emitBalanceUpdate(creditedUserId, creditedNewBalance);
    }
  } catch (error) {
    logger.error('Failed to credit chips', {
      error: (error as Error).message,
      userAddress,
      amount: amount.toString(),
      txHash,
      blockNumber,
    });
    throw error;
  }
}

/**
 * Process a deposit event
 */
async function processDepositEvent(
  user: string,
  amount: bigint,
  _timestamp: bigint,
  blockNumber: bigint,
  event: ethers.EventLog
) {
  const txHash = event.transactionHash;
  const blockNum = Number(blockNumber);

  logger.info('Deposit event received', {
    user,
    amount: amount.toString(),
    txHash,
    blockNumber: blockNum,
  });

  // Check if already processed
  const existing = await prisma.deposit.findUnique({
    where: { txHash },
  });

  if (existing) {
    logger.debug('Deposit already processed, skipping', { txHash });
    return;
  }

  // Wait for confirmations with polling
  const waitForConfirmations = async () => {
    let confirmations = 0;
    
    while (confirmations < CONFIG.CONFIRMATIONS) {
      const currentBlock = await provider.getBlockNumber();
      confirmations = currentBlock - blockNum;

      if (confirmations < CONFIG.CONFIRMATIONS) {
        logger.info('Waiting for confirmations', {
          txHash,
          confirmations,
          required: CONFIG.CONFIRMATIONS,
        });
        
        // Wait 3 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    logger.info('Confirmations met, crediting chips', {
      txHash,
      confirmations,
    });

    // Credit chips
    await creditChips(user, amount, txHash, blockNum);
  };

  // Start confirmation polling (non-blocking)
  waitForConfirmations().catch((error) => {
    logger.error('Error waiting for confirmations', { error, txHash });
  });
}

/**
 * Sync historical deposits (run once on startup)
 */
export async function syncHistoricalDeposits() {
  try {
    logger.info('Syncing historical deposits...');

    // Get the latest processed block from database
    const latestDeposit = await prisma.deposit.findFirst({
      orderBy: { blockNumber: 'desc' },
    });

    const fromBlock = latestDeposit ? latestDeposit.blockNumber + 1 : 0;
    const currentBlock = await provider.getBlockNumber();

    if (fromBlock >= currentBlock) {
      logger.info('No new blocks to sync');
      return;
    }

    logger.info('Fetching historical deposits', {
      fromBlock,
      toBlock: currentBlock,
    });

    // Fetch all deposit events
    const events = await vault.queryFilter(
      vault.filters.Deposit(),
      fromBlock,
      currentBlock
    );

    logger.info(`Found ${events.length} historical deposit(s)`);

    for (const event of events) {
      if (event instanceof ethers.EventLog) {
        const [user, amount, timestamp, blockNumber] = event.args;
        await processDepositEvent(user, amount, timestamp, blockNumber, event);
      }
    }

    logger.info('Historical sync complete');
  } catch (error) {
    logger.error('Failed to sync historical deposits', { error });
    throw error;
  }
}

/**
 * Start listening for new deposit events
 */
export function startBlockchainListener() {
  if (isListening) {
    logger.warn('Blockchain listener already running');
    return;
  }

  initializeBlockchain();

  // Sync historical deposits first
  syncHistoricalDeposits().catch((error) => {
    logger.error('Initial sync failed', { error });
  });

  // Listen for new deposits
  vault.on('Deposit', async (user, amount, timestamp, blockNumber, eventPayload) => {
    try {
      // In ethers v6, eventPayload.log contains the actual Log object
      const log = eventPayload.log;
      
      logger.info('New deposit detected', {
        user,
        amount: amount.toString(),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });

      // Pass the log as an EventLog to processDepositEvent
      await processDepositEvent(user, amount, timestamp, blockNumber, log as ethers.EventLog);
    } catch (error) {
      logger.error('Failed to process deposit event', { error });
    }
  });

  isListening = true;
  logger.info('Blockchain listener started', {
    contract: CONFIG.CONTRACT_ADDRESS,
    confirmations: CONFIG.CONFIRMATIONS,
  });
}

/**
 * Stop listening (for graceful shutdown)
 */
export function stopBlockchainListener() {
  if (!isListening) {
    return;
  }

  vault.removeAllListeners('Deposit');
  isListening = false;
  logger.info('Blockchain listener stopped');
}

/**
 * Get listener status
 */
export function getListenerStatus() {
  return {
    isListening,
    contract: CONFIG.CONTRACT_ADDRESS,
    network: CONFIG.CHAIN_ID,
    confirmations: CONFIG.CONFIRMATIONS,
  };
}
