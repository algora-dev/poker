import { ethers } from 'hardhat';

async function testWithdrawal() {
  const [deployer] = await ethers.getSigners();
  
  console.log('\n=== Test Withdrawal ===');
  console.log('Wallet:', deployer.address);
  
  const vaultAddress = process.env.CONTRACT_ADDRESS || '0x41DE77179744AE449559b9D348e02547BD83A260';
  const mUSDAddress = process.env.MUSD_TOKEN_ADDRESS || '0xacA92E438df0B2401fF60dA7E4337B687a2435DA';
  
  // Connect to contracts
  const vault = await ethers.getContractAt('PokerChipVault', vaultAddress);
  const mUSD = await ethers.getContractAt(
    ['function balanceOf(address) view returns (uint256)'],
    mUSDAddress
  );
  
  // Check balances before
  const walletBalanceBefore = await mUSD.balanceOf(deployer.address);
  const contractBalance = await vault.getTotalBalance();
  const totalDeposits = await vault.totalDeposits(deployer.address);
  
  console.log('\n=== Before Withdrawal ===');
  console.log('Your mUSD Balance:', ethers.formatUnits(walletBalanceBefore, 6), 'mUSD');
  console.log('Contract Balance:', ethers.formatUnits(contractBalance, 6), 'mUSD');
  console.log('Your Total Deposits:', ethers.formatUnits(totalDeposits, 6), 'mUSD');
  
  // Amount to withdraw (all of it)
  const withdrawAmount = totalDeposits;
  console.log('\nWithdrawing:', ethers.formatUnits(withdrawAmount, 6), 'mUSD');
  
  // Step 1: Request withdrawal
  console.log('\n[1/2] Requesting withdrawal...');
  const requestTx = await vault.requestWithdrawal(withdrawAmount);
  console.log('Request tx:', requestTx.hash);
  await requestTx.wait();
  console.log('✅ Withdrawal requested');
  
  // Check pending withdrawal
  const pending = await vault.pendingWithdrawals(deployer.address);
  console.log('Pending withdrawal:', ethers.formatUnits(pending, 6), 'mUSD');
  
  // Step 2: Owner approves and completes withdrawal
  console.log('\n[2/2] Owner approving withdrawal...');
  const completeTx = await vault.completeWithdrawal(deployer.address, withdrawAmount);
  console.log('Complete tx:', completeTx.hash);
  const receipt = await completeTx.wait();
  console.log('✅ Withdrawal completed');
  
  // Check events
  console.log('\n=== Events ===');
  const requestEvent = receipt?.logs.find((log: any) => {
    try {
      return vault.interface.parseLog(log)?.name === 'WithdrawalCompleted';
    } catch {
      return false;
    }
  });
  
  if (requestEvent) {
    const parsed = vault.interface.parseLog(requestEvent);
    console.log('WithdrawalCompleted Event:');
    console.log('  User:', parsed?.args[0]);
    console.log('  Amount:', ethers.formatUnits(parsed?.args[1], 6), 'mUSD');
  }
  
  // Check balances after
  const walletBalanceAfter = await mUSD.balanceOf(deployer.address);
  const contractBalanceAfter = await vault.getTotalBalance();
  const pendingAfter = await vault.pendingWithdrawals(deployer.address);
  
  console.log('\n=== After Withdrawal ===');
  console.log('Your mUSD Balance:', ethers.formatUnits(walletBalanceAfter, 6), 'mUSD');
  console.log('Change:', ethers.formatUnits(walletBalanceAfter - walletBalanceBefore, 6), 'mUSD');
  console.log('Contract Balance:', ethers.formatUnits(contractBalanceAfter, 6), 'mUSD');
  console.log('Pending Withdrawal:', ethers.formatUnits(pendingAfter, 6), 'mUSD');
  
  console.log('\n✅ Test Complete');
  console.log('\nView transactions on LineaScan:');
  console.log('Request:', `https://lineascan.build/tx/${requestTx.hash}`);
  console.log('Complete:', `https://lineascan.build/tx/${completeTx.hash}`);
}

testWithdrawal().catch((error) => {
  console.error(error);
  process.exit(1);
});
