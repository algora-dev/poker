import { ethers } from 'hardhat';

async function main() {
  const CONTRACT_ADDRESS = '0x41DE77179744AE449559b9D348e02547BD83A260';
  const RECIPIENT = '0x145e5b0be0840Bd7F6536dA1a24dbA58E7792382';
  const AMOUNT = ethers.parseUnits('2.0', 6); // 2.0 mUSD (6 decimals)

  console.log('Refunding deposits...');
  console.log('Contract:', CONTRACT_ADDRESS);
  console.log('Recipient:', RECIPIENT);
  console.log('Amount:', ethers.formatUnits(AMOUNT, 6), 'mUSD');

  const [signer] = await ethers.getSigners();
  console.log('Signer:', signer.address);

  const Vault = await ethers.getContractFactory('PokerChipVault');
  const vault = Vault.attach(CONTRACT_ADDRESS);

  // Check contract balance
  const musdAddress = await vault.token();
  const MUSD = await ethers.getContractAt('IERC20', musdAddress);
  const contractBalance = await MUSD.balanceOf(CONTRACT_ADDRESS);
  
  console.log('Contract mUSD balance:', ethers.formatUnits(contractBalance, 6));

  if (contractBalance < AMOUNT) {
    throw new Error('Insufficient contract balance');
  }

  // Execute withdrawal
  console.log('\nWithdrawing fees...');
  const tx = await vault.withdrawFees(AMOUNT);
  console.log('Transaction hash:', tx.hash);
  console.log('Waiting for confirmation...');
  
  const receipt = await tx.wait();
  console.log('✅ Transaction confirmed in block:', receipt?.blockNumber);

  // Verify recipient balance increased
  const recipientBalance = await MUSD.balanceOf(RECIPIENT);
  console.log('Recipient mUSD balance:', ethers.formatUnits(recipientBalance, 6));

  console.log('\n✅ Refund complete!');
  console.log('LineaScan:', `https://lineascan.build/tx/${tx.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
