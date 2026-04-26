# Profit Withdrawal Guide (MVP - Manual Verification)

## Overview

The contract allows the owner to withdraw house profits (fees collected from games), but **you must manually verify** that you're not draining player funds.

---

## ⚠️ CRITICAL: Manual Verification Required

**Before every `withdrawProfit()` call:**

1. **Check total player chip liability in database:**
   ```sql
   SELECT SUM(chips) as total_chips FROM chip_balances;
   ```

2. **Check contract mUSD balance:**
   ```javascript
   const contractBalance = await vault.getTotalBalance();
   ```

3. **Calculate safe withdrawal:**
   ```
   safeWithdrawal = contractBalance - totalChips
   ```

4. **Withdraw only up to `safeWithdrawal`:**
   ```javascript
   await vault.withdrawProfit(safeWithdrawal);
   ```

**Why:** The contract does NOT know about off-chain chip balances. It trusts you to do the math correctly.

---

## Example Scenario

### Initial State
- Player A deposits 100 mUSD → gets 100 chips
- Player B deposits 50 mUSD → gets 50 chips
- **Contract:** 150 mUSD
- **Database:** 150 chips total
- **Safe withdrawal:** 0 mUSD

### After Games + Fees
- Player A loses 10 chips in rake → house keeps 10 chips
- Player B loses 5 chips in rake → house keeps 5 chips
- **Contract:** 150 mUSD (unchanged on-chain)
- **Database:** 135 chips (150 - 15 fees)
- **Safe withdrawal:** 15 mUSD (150 - 135)

### Withdrawal
```javascript
// Query database
const totalChips = 135; // from SELECT SUM(chips)

// Check contract
const contractBalance = await vault.getTotalBalance(); // 150 mUSD

// Calculate
const safeAmount = contractBalance - totalChips; // 15 mUSD

// Withdraw
await vault.withdrawProfit(ethers.parseUnits('15', 6));
```

**Result:**
- Contract: 135 mUSD
- Database: 135 chips
- Owner wallet: +15 mUSD profit

---

## Withdrawal Workflow

### 1. Connect to Database (Backend)
```typescript
import { prisma } from './db/client';

async function getTotalChipLiability(): Promise<bigint> {
  const result = await prisma.chipBalance.aggregate({
    _sum: {
      chips: true,
    },
  });
  
  return result._sum.chips || 0n;
}
```

### 2. Check Contract Balance (Blockchain)
```typescript
import { ethers } from 'ethers';
import { CONFIG } from './config';

const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
const vault = new ethers.Contract(
  CONFIG.CONTRACT_ADDRESS,
  ['function getTotalBalance() view returns (uint256)'],
  provider
);

const contractBalance = await vault.getTotalBalance();
console.log('Contract Balance:', ethers.formatUnits(contractBalance, 6), 'mUSD');
```

### 3. Calculate Safe Amount
```typescript
const totalChips = await getTotalChipLiability(); // from database
const contractBalance = await vault.getTotalBalance(); // from blockchain

const safeWithdrawal = contractBalance - totalChips;

if (safeWithdrawal <= 0n) {
  console.log('No profit available to withdraw');
  return;
}

console.log('Safe to withdraw:', ethers.formatUnits(safeWithdrawal, 6), 'mUSD');
```

### 4. Execute Withdrawal
```typescript
const vaultWithSigner = vault.connect(wallet);

const tx = await vaultWithSigner.withdrawProfit(safeWithdrawal);
console.log('Transaction hash:', tx.hash);

await tx.wait();
console.log('Profit withdrawn successfully!');
```

---

## Safety Checks

### Before Withdrawing, Ask Yourself:

1. **Did I query the latest chip balances?** (Not cached data)
2. **Is there a pending withdrawal I forgot about?** (Check `pendingWithdrawals` table)
3. **Did I account for all players?** (Including inactive/offline players)
4. **Am I leaving a buffer?** (Optional: withdraw 90% of calculated profit for safety)

### Red Flags (DON'T WITHDRAW IF):

- ❌ You haven't checked the database in the last hour
- ❌ You're unsure about the chip balance query
- ❌ The calculated profit seems too high (double-check math)
- ❌ There are pending player withdrawals you haven't processed

---

## Recommended Script

Create a backend script for safe withdrawals:

```typescript
// scripts/withdraw-profit.ts
import { prisma } from '../src/db/client';
import { ethers } from 'ethers';
import { CONFIG } from '../src/config';

async function withdrawProfit() {
  // 1. Get total chip liability
  const totalChips = await prisma.chipBalance.aggregate({
    _sum: { chips: true },
  });
  
  if (!totalChips._sum.chips) {
    console.log('No chip balances found');
    return;
  }
  
  console.log('Total player chips:', totalChips._sum.chips.toString());
  
  // 2. Get contract balance
  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
  const vault = new ethers.Contract(
    CONFIG.CONTRACT_ADDRESS,
    [
      'function getTotalBalance() view returns (uint256)',
      'function withdrawProfit(uint256) external',
    ],
    wallet
  );
  
  const contractBalance = await vault.getTotalBalance();
  console.log('Contract balance:', ethers.formatUnits(contractBalance, 6), 'mUSD');
  
  // 3. Calculate safe withdrawal
  const totalChipsBigInt = BigInt(totalChips._sum.chips.toString());
  const safeWithdrawal = contractBalance - totalChipsBigInt;
  
  if (safeWithdrawal <= 0n) {
    console.log('No profit available (contract balance <= chip liability)');
    return;
  }
  
  console.log('Available profit:', ethers.formatUnits(safeWithdrawal, 6), 'mUSD');
  
  // 4. Optional: Apply safety margin (withdraw 95% of profit)
  const safetyMargin = 0.95;
  const withdrawAmount = (safeWithdrawal * BigInt(Math.floor(safetyMargin * 100))) / 100n;
  
  console.log('Withdrawing (with 5% buffer):', ethers.formatUnits(withdrawAmount, 6), 'mUSD');
  
  // 5. Execute withdrawal
  console.log('\n⚠️  About to withdraw profit. Press Ctrl+C to cancel, or wait 5 seconds...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const tx = await vault.withdrawProfit(withdrawAmount);
  console.log('Transaction sent:', tx.hash);
  
  const receipt = await tx.wait();
  console.log('✅ Profit withdrawn successfully!');
  console.log('Gas used:', receipt.gasUsed.toString());
}

withdrawProfit().catch(console.error);
```

**Usage:**
```bash
cd packages/backend
npx tsx scripts/withdraw-profit.ts
```

---

## Future: Automated Oracle (Option C)

**After MVP, we'll implement:**
- Backend reports total chip liability to contract every 15 minutes
- Contract enforces: `withdrawProfit()` only works if data is fresh (<1 hour)
- No manual verification needed
- On-chain protection against draining player funds

See `packages/backend/src/blockchain/TODO-ORACLE.md` for details.

---

## FAQ

**Q: What if I withdraw too much by mistake?**  
A: Players won't be able to withdraw, and you'll need to deposit mUSD back into the contract to cover their chips.

**Q: Can players see how much profit I'm taking?**  
A: Yes, `ProfitWithdrawn` events are on-chain and public. This is transparent by design.

**Q: Should I withdraw profit daily? Weekly?**  
A: Up to you. More frequent = more gas fees. Weekly is reasonable.

**Q: What if there's a big pending withdrawal?**  
A: Check `pendingWithdrawals` table before calculating profit. Subtract those amounts from available profit.

---

**Status:** MVP manual verification. Automated oracle coming in Phase 2.
