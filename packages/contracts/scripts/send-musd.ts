import { ethers } from 'hardhat';

async function main() {
  const MUSD_ADDRESS = '0xacA92E438df0B2401fF60dA7E4337B687a2435DA';
  const RECIPIENT = '0x145e5b0be0840Bd7F6536dA1a24dbA58E7792382';
  const AMOUNT = ethers.parseUnits('2.0', 6); // 2.0 mUSD (6 decimals) - 2nd refund

  console.log('Sending mUSD...');
  console.log('To:', RECIPIENT);
  console.log('Amount:', ethers.formatUnits(AMOUNT, 6), 'mUSD');

  const [signer] = await ethers.getSigners();
  console.log('From:', signer.address);

  const MUSD = await ethers.getContractAt('IERC20', MUSD_ADDRESS);
  
  // Check sender balance
  const balance = await MUSD.balanceOf(signer.address);
  console.log('Sender balance:', ethers.formatUnits(balance, 6), 'mUSD');

  if (balance < AMOUNT) {
    throw new Error('Insufficient balance');
  }

  // Transfer
  console.log('\nTransferring...');
  const tx = await MUSD.transfer(RECIPIENT, AMOUNT);
  console.log('Transaction hash:', tx.hash);
  console.log('Waiting for confirmation...');
  
  const receipt = await tx.wait();
  console.log('✅ Transaction confirmed in block:', receipt?.blockNumber);

  // Verify recipient received it
  const recipientBalance = await MUSD.balanceOf(RECIPIENT);
  console.log('Recipient new balance:', ethers.formatUnits(recipientBalance, 6), 'mUSD');

  console.log('\n✅ Transfer complete!');
  console.log('LineaScan:', `https://lineascan.build/tx/${tx.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
