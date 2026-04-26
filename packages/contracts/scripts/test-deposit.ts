import { ethers } from 'hardhat';

async function testDeposit() {
  const [deployer] = await ethers.getSigners();
  
  console.log('\n=== Test Deposit ===');
  console.log('Wallet:', deployer.address);
  
  const vaultAddress = process.env.CONTRACT_ADDRESS || '0x41DE77179744AE449559b9D348e02547BD83A260';
  const mUSDAddress = process.env.MUSD_TOKEN_ADDRESS || '0xacA92E438df0B2401fF60dA7E4337B687a2435DA';
  
  // Connect to contracts
  const vault = await ethers.getContractAt('PokerChipVault', vaultAddress);
  const mUSD = await ethers.getContractAt(
    ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'],
    mUSDAddress
  );
  
  // Check balances before
  const balanceBefore = await mUSD.balanceOf(deployer.address);
  console.log('\nmUSD Balance Before:', ethers.formatUnits(balanceBefore, 6), 'mUSD');
  
  const contractBalanceBefore = await vault.getTotalBalance();
  console.log('Contract Balance Before:', ethers.formatUnits(contractBalanceBefore, 6), 'mUSD');
  
  // Amount to deposit: 1.0 mUSD (minimum)
  const depositAmount = ethers.parseUnits('1.0', 6);
  console.log('\nDepositing:', ethers.formatUnits(depositAmount, 6), 'mUSD');
  
  // Step 1: Approve
  console.log('\n[1/2] Approving vault to spend mUSD...');
  const approveTx = await mUSD.approve(vaultAddress, depositAmount);
  console.log('Approve tx:', approveTx.hash);
  await approveTx.wait();
  console.log('✅ Approved');
  
  // Step 2: Deposit
  console.log('\n[2/2] Depositing to vault...');
  const depositTx = await vault.deposit(depositAmount);
  console.log('Deposit tx:', approveTx.hash);
  const receipt = await depositTx.wait();
  console.log('✅ Deposited');
  
  // Check events
  console.log('\n=== Events ===');
  const depositEvent = receipt?.logs.find((log: any) => {
    try {
      return vault.interface.parseLog(log)?.name === 'Deposit';
    } catch {
      return false;
    }
  });
  
  if (depositEvent) {
    const parsed = vault.interface.parseLog(depositEvent);
    console.log('Deposit Event:');
    console.log('  User:', parsed?.args[0]);
    console.log('  Amount:', ethers.formatUnits(parsed?.args[1], 6), 'mUSD');
    console.log('  Block:', parsed?.args[3].toString());
  }
  
  // Check balances after
  const balanceAfter = await mUSD.balanceOf(deployer.address);
  console.log('\n=== Balances After ===');
  console.log('mUSD Balance:', ethers.formatUnits(balanceAfter, 6), 'mUSD');
  console.log('Change:', ethers.formatUnits(balanceBefore - balanceAfter, 6), 'mUSD');
  
  const contractBalanceAfter = await vault.getTotalBalance();
  console.log('Contract Balance:', ethers.formatUnits(contractBalanceAfter, 6), 'mUSD');
  console.log('Change:', ethers.formatUnits(contractBalanceAfter - contractBalanceBefore, 6), 'mUSD');
  
  // Check user's total deposits
  const totalDeposits = await vault.totalDeposits(deployer.address);
  console.log('\nYour Total Deposits:', ethers.formatUnits(totalDeposits, 6), 'mUSD');
  
  console.log('\n✅ Test Complete');
  console.log('\nView transactions on LineaScan:');
  console.log('Approve:', `https://lineascan.build/tx/${approveTx.hash}`);
  console.log('Deposit:', `https://lineascan.build/tx/${depositTx.hash}`);
}

testDeposit().catch((error) => {
  console.error(error);
  process.exit(1);
});
