# Deployment Record

## Linea Mainnet Deployment

**Date:** 2026-04-09 15:37 GMT+1  
**Status:** ✅ Successfully Deployed

### Contract Details

**PokerChipVault:**
- Address: `0x41DE77179744AE449559b9D348e02547BD83A260`
- Owner: `0x6f98ecaA66D5ABa188716070372F1B81d443d1c9`
- Network: Linea Mainnet (Chain ID: 59144)
- Compiler: Solidity 0.8.20
- Optimized: Yes (200 runs)

**Token:**
- mUSD: `0xacA92E438df0B2401fF60dA7E4337B687a2435DA`

**Deployer:**
- Address: `0x6f98ecaA66D5ABa188716070372F1B81d443d1c9`
- Starting Balance: 0.00115 ETH
- Deployment Cost: ~0.00115 ETH

**View on Explorer:**
- Contract: https://lineascan.build/address/0x41DE77179744AE449559b9D348e02547BD83A260
- Deployer: https://lineascan.build/address/0x6f98ecaA66D5ABa188716070372F1B81d443d1c9

### Contract Features

**Deposits:**
- Users deposit mUSD → receive chips (1:1)
- Minimum deposit: 1 mUSD (1000000 with 6 decimals)
- Events: `Deposit(user, amount, timestamp, blockNumber)`

**Withdrawals:**
- Two-step process: request → owner approval → payout
- Minimum withdrawal: 1 mUSD
- Owner can reject with reason
- Events: `WithdrawalRequested`, `WithdrawalCompleted`, `WithdrawalRejected`

**Fee Withdrawal (Owner Only):**
- Manual verification required (check backend chip balances)
- Function: `withdrawFees(uint256 amount)`
- Owner responsibility: ensure `contractBalance - amount >= totalPlayerChips`
- Event: `FeesWithdrawn(owner, amount, timestamp)`

**Admin Functions:**
- Pause/unpause deposits & withdrawals (emergency)
- Update minimum deposit/withdrawal amounts
- Transfer ownership

**Security:**
- OpenZeppelin contracts (v5.0.2)
- ReentrancyGuard on all value transfers
- Pausable for emergency stops
- SafeERC20 for token interactions

### Verification

**Command:**
```bash
npx hardhat verify --network linea 0x41DE77179744AE449559b9D348e02547BD83A260 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

**Status:** Pending (optional for transparency)

### Next Steps

1. ✅ Contract deployed
2. ⏳ Update backend `.env` with contract address
3. ⏳ Update frontend `.env` with contract address
4. ⏳ Implement blockchain listener (backend)
5. ⏳ Implement deposit flow (frontend)
6. ⏳ Test end-to-end deposit → chip credit
7. ⏳ Implement withdrawal flow
8. ⏳ Test fee withdrawal function

### Configuration Values

**For Backend (.env):**
```env
CONTRACT_ADDRESS=0x41DE77179744AE449559b9D348e02547BD83A260
MUSD_TOKEN_ADDRESS=0xacA92E438df0B2401fF60dA7E4337B687a2435DA
PRIVATE_KEY=ed1fa1fe6db69f1f039c58ae278277ec2edf7f0a647224293e49f3f29a48121f
RPC_URL=https://rpc.linea.build
CHAIN_ID=59144
CONFIRMATIONS=6
```

**For Frontend (.env):**
```env
VITE_CONTRACT_ADDRESS=0x41DE77179744AE449559b9D348e02547BD83A260
VITE_MUSD_TOKEN_ADDRESS=0xacA92E438df0B2401fF60dA7E4337B687a2435DA
VITE_CHAIN_ID=59144
VITE_RPC_URL=https://rpc.linea.build
```

---

## Important Notes

### Owner Responsibilities

As contract owner (`0x6f98ecaA66D5ABa188716070372F1B81d443d1c9`), you can:
- Approve/reject player withdrawals
- Withdraw house fees (after manual verification)
- Pause contract in emergencies
- Update minimum amounts
- Transfer ownership

### Fee Withdrawal Process (Manual MVP)

**Before calling `withdrawFees()`:**
1. Query backend: `SELECT SUM(chips) FROM chip_balances`
2. Query contract: `vault.getTotalBalance()`
3. Calculate: `safeAmount = contractBalance - totalChips`
4. Execute: `vault.withdrawFees(safeAmount)`

**See:** `FEE_WITHDRAWAL_GUIDE.md` for detailed instructions

### Security Reminders

- Contract is live on mainnet with real money
- All player deposits are now tracked on-chain
- Backend must implement blockchain listener (watches `Deposit` events)
- Never withdraw more fees than `contractBalance - playerChipLiability`
- Keep owner wallet private key secure

---

## Testing Checklist

- [ ] Test deposit: Send mUSD to contract, verify event emitted
- [ ] Test backend listener: Verify chips credited in database
- [ ] Test withdrawal request: User requests, check `pendingWithdrawals`
- [ ] Test withdrawal approval: Owner approves, verify mUSD transferred
- [ ] Test fee withdrawal: Verify manual verification process works
- [ ] Test pause function: Emergency stop, verify deposits/withdrawals blocked

---

**Deployment Status:** ✅ Complete  
**Production Ready:** ⏳ Pending backend integration

---

Last updated: 2026-04-09 15:37 GMT+1
