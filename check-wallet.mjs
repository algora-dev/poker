import { ethers } from 'ethers';

const PRIVATE_KEY = 'ed1fa1fe6db69f1f039c58ae278277ec2edf7f0a647224293e49f3f29a48121f';
const RPC_URL = 'https://rpc.goerli.linea.build';
const MUSD_ADDRESS = '0xacA92E438df0B2401fF60dA7E4337B687a2435DA';

async function checkWallet() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log('=== Wallet Info ===');
  console.log('Address:', wallet.address);
  
  const ethBalance = await provider.getBalance(wallet.address);
  console.log('ETH Balance:', ethers.formatEther(ethBalance), 'ETH');
  
  // Check mUSD balance
  const mUSDContract = new ethers.Contract(
    MUSD_ADDRESS,
    ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
    provider
  );
  
  try {
    const mUSDBalance = await mUSDContract.balanceOf(wallet.address);
    const decimals = await mUSDContract.decimals();
    console.log('mUSD Balance:', ethers.formatUnits(mUSDBalance, decimals), 'mUSD');
  } catch (err) {
    console.log('mUSD Balance: Unable to fetch (token may not exist on testnet)');
  }
  
  console.log('\n=== Network Info ===');
  const network = await provider.getNetwork();
  console.log('Network:', network.name);
  console.log('Chain ID:', network.chainId.toString());
}

checkWallet().catch(console.error);
