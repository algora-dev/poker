# TODO: Implement Oracle Pattern for Player Liability (Option C)

## Current State (MVP - Option B)

**Profit Withdrawal:** Manual verification
- Owner checks `SELECT SUM(chips) FROM chip_balances` in Postgres
- Owner calculates: `contractBalance - totalChips = safeWithdrawal`
- Owner calls `vault.withdrawProfit(amount)`
- Contract trusts owner, just checks balance exists

**Risk:** Owner could accidentally drain player funds if they miscalculate

---

## Future Production (Option C)

**Automated Liability Reporting:**

1. **Backend Job (runs every 15 minutes):**
   ```typescript
   async function updateLiabilityOnChain() {
     // Query database
     const totalChips = await prisma.chipBalance.aggregate({
       _sum: { chips: true }
     });
     
     // Report to contract
     await vault.updatePlayerLiability(totalChips._sum.chips);
   }
   ```

2. **Contract Enforcement:**
   ```solidity
   uint256 public reportedPlayerLiability;
   uint256 public lastLiabilityUpdate;

   function updatePlayerLiability(uint256 totalChips) external onlyOwner {
       reportedPlayerLiability = totalChips;
       lastLiabilityUpdate = block.timestamp;
   }

   function withdrawProfit(uint256 amount) external onlyOwner {
       require(
           block.timestamp - lastLiabilityUpdate < 1 hours,
           "Liability data stale"
       );
       require(
           token.balanceOf(address(this)) >= reportedPlayerLiability + amount,
           "Insufficient profit"
       );
       // withdraw...
   }
   ```

3. **Benefits:**
   - On-chain enforcement of player protection
   - Cannot withdraw profit if data is stale (>1 hour old)
   - Transparent on-chain record of liability
   - Automated, no manual calculation needed

---

## Migration Path

1. ✅ **Phase 1 (MVP):** Manual verification (current implementation)
2. **Phase 2:** Deploy new contract with liability reporting
3. **Phase 3:** Backend job updates liability every 15 minutes
4. **Phase 4:** Remove manual verification, rely on contract enforcement

---

## Implementation Checklist

- [ ] Update contract with `updatePlayerLiability()` function
- [ ] Add `lastLiabilityUpdate` timestamp check
- [ ] Create backend cron job to report liability
- [ ] Add monitoring/alerts if liability update fails
- [ ] Test with testnet before mainnet upgrade
- [ ] Document owner wallet must have ETH for liability updates

---

**For now:** Owner manually verifies before each `withdrawProfit()` call.
**Later:** Automated on-chain enforcement via oracle pattern.
