const { ethers } = require('ethers');
require('dotenv').config();

async function checkBalance() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  console.log('\n=== Wallet Info ===');
  console.log('Address:', wallet.address);
  
  const ethBalance = await provider.getBalance(wallet.address);
  console.log('ETH Balance:', ethers.formatEther(ethBalance), 'ETH');
  
  // Check mUSD balance
  const mUSDContract = new ethers.Contract(
    process.env.MUSD_TOKEN_ADDRESS,
    [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)'
    ],
    provider
  );
  
  try {
    const mUSDBalance = await mUSDContract.balanceOf(wallet.address);
    const decimals = await mUSDContract.decimals();
    console.log('mUSD Balance:', ethers.formatUnits(mUSDBalance, decimals), 'mUSD');
  } catch (err) {
    console.log('mUSD Balance: Error -', err.message);
  }
  
  const network = await provider.getNetwork();
  console.log('\n=== Network ===');
  console.log('Chain ID:', network.chainId.toString());
  console.log('Name:', network.name || 'lineaTestnet');
  console.log('\n');
}

checkBalance().catch(console.error);
