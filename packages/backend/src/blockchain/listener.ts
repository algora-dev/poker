import { ethers } from 'ethers';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';
import { findActiveAuthorization, markAuthorizationUsed } from '../services/wallet';
import { emitBalanceUpdate } from '../socket';

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
    // Check for active deposit authorization
    const authorization = await findActiveAuthorization(userAddress);

    if (!authorization) {
      logger.warn('Deposit attempted without authorization', {
        walletAddress: userAddress,
        txHash,
        amount: amount.toString(),
      });
      // TODO: Add to pending deposits table for manual review
      return;
    }

    // Convert mUSD to chips (1:1 ratio, both use 6 decimals)
    const chips = amount;

    await prisma.$transaction(async (tx) => {
      // Get user from authorization (not from wallet address)
      const user = await tx.user.findUnique({
        where: { id: authorization.userId },
      });

      if (!user) {
        logger.error('User not found for authorized deposit', {
          userId: authorization.userId,
          walletAddress: userAddress,
        });
        return;
      }

      // Create or update chip balance
      const chipBalance = await tx.chipBalance.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          chips,
        },
        update: {
          chips: {
            increment: chips,
          },
        },
      });

      // Record deposit in ledger
      await tx.deposit.create({
        data: {
          userId: user.id,
          amount,
          txHash,
          blockNumber,
          confirmed: true,
        },
      });

      // Create audit log
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

      // Mark authorization as used
      await markAuthorizationUsed(authorization.id);

      logger.info('Chips credited successfully', {
        userId: user.id,
        walletAddress: userAddress,
        amount: amount.toString(),
        chips: chips.toString(),
        txHash,
        blockNumber,
        newBalance: chipBalance.chips.toString(),
      });

      // Emit real-time balance update to user
      emitBalanceUpdate(user.id, chipBalance.chips.toString());
    });
  } catch (error) {
    logger.error('Failed to credit chips', {
      error,
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
