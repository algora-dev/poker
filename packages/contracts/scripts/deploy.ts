import { ethers } from 'hardhat';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log('Deploying contracts with account:', deployer.address);
  console.log('Account balance:', (await ethers.provider.getBalance(deployer.address)).toString());

  const mUSDTokenAddress = process.env.MUSD_TOKEN_ADDRESS;
  if (!mUSDTokenAddress) {
    throw new Error('MUSD_TOKEN_ADDRESS not set in .env');
  }

  console.log('Using mUSD token address:', mUSDTokenAddress);

  // Deploy PokerChipVault
  const PokerChipVault = await ethers.getContractFactory('PokerChipVault');
  const vault = await PokerChipVault.deploy(mUSDTokenAddress);

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  console.log('PokerChipVault deployed to:', vaultAddress);
  console.log('Owner:', await vault.owner());
  console.log('Token:', await vault.token());

  // Save deployment info
  console.log('\n=== Deployment Summary ===');
  console.log('Network:', (await ethers.provider.getNetwork()).name);
  console.log('Chain ID:', (await ethers.provider.getNetwork()).chainId);
  console.log('Contract Address:', vaultAddress);
  console.log('Deployer:', deployer.address);
  console.log('\n=== Update your .env files with: ===');
  console.log(`CONTRACT_ADDRESS=${vaultAddress}`);
  console.log('\n=== Verify contract with: ===');
  console.log(`npx hardhat verify --network linea ${vaultAddress} ${mUSDTokenAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
