# Deployment Guide for Shaun

## 📋 Pre-Deployment Checklist

### 1. Install Dependencies

```bash
cd projects/Poker/poker-game/packages/contracts
npm install
```

### 2. Create `.env` File

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
# Linea Mainnet RPC
RPC_URL=https://rpc.linea.build
CHAIN_ID=59144

# Your deployer wallet private key (KEEP THIS SECRET!)
PRIVATE_KEY=0x...

# LineaScan API key (optional, for contract verification)
LINEASCAN_API_KEY=YOUR_API_KEY

# mUSD token address (already filled)
MUSD_TOKEN_ADDRESS=0xacA92E438df0B2401fF60dA7E4337B687a2435DA

# Gas reporting (optional)
REPORT_GAS=false
```

**⚠️ IMPORTANT:** Never commit `.env` to git! It's already in `.gitignore`.

---

## 🧪 Test on Linea Testnet First (Recommended)

### 1. Get Testnet ETH

- Linea Goerli Testnet faucet: https://faucet.goerli.linea.build
- Or bridge from Goerli ETH

### 2. Update `.env` for Testnet

```env
RPC_URL=https://rpc.goerli.linea.build
CHAIN_ID=59140
PRIVATE_KEY=0x...  # Your testnet wallet
```

### 3. Deploy to Testnet

```bash
npm run deploy:testnet
```

**Expected output:**
```
Deploying contracts with account: 0x...
Account balance: ...
Using mUSD token address: 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
PokerChipVault deployed to: 0x...
Owner: 0x...
Token: 0xacA92E438df0B2401fF60dA7E4337B687a2435DA

=== Deployment Summary ===
Network: lineaTestnet
Chain ID: 59140
Contract Address: 0x...
Deployer: 0x...

=== Update your .env files with: ===
CONTRACT_ADDRESS=0x...

=== Verify contract with: ===
npx hardhat verify --network lineaTestnet 0x... 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

### 4. Copy Contract Address

Save the deployed contract address — you'll need it for backend + frontend `.env` files.

### 5. Verify Contract (Optional)

```bash
npx hardhat verify --network lineaTestnet <CONTRACT_ADDRESS> 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

This makes the contract code visible on LineaScan.

---

## 🚀 Deploy to Linea Mainnet

### 1. Fund Deployer Wallet

Make sure your deployer wallet has **ETH on Linea mainnet** for gas.

Estimate: ~0.002 ETH (gas is cheap on Linea, but budget 0.01 ETH to be safe).

### 2. Update `.env` for Mainnet

```env
RPC_URL=https://rpc.linea.build
CHAIN_ID=59144
PRIVATE_KEY=0x...  # Your mainnet wallet (KEEP SECRET!)
MUSD_TOKEN_ADDRESS=0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

### 3. Compile Contracts

```bash
npm run compile
```

Verify no errors.

### 4. Run Tests (Sanity Check)

```bash
npm run test
```

All tests should pass.

### 5. Deploy to Mainnet

```bash
npm run deploy:mainnet
```

**⚠️ THIS IS REAL MONEY — Double-check everything before running!**

**Expected output:**
```
Deploying contracts with account: 0x...
Account balance: ...
Using mUSD token address: 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
PokerChipVault deployed to: 0x...
Owner: 0x...
Token: 0xacA92E438df0B2401fF60dA7E4337B687a2435DA

=== Deployment Summary ===
Network: linea
Chain ID: 59144
Contract Address: 0x...
Deployer: 0x...

=== Update your .env files with: ===
CONTRACT_ADDRESS=0x...

=== Verify contract with: ===
npx hardhat verify --network linea 0x... 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

### 6. Copy Contract Address

**Send this to me:**
- **Contract Address:** `0x...`
- **Deployer Address:** `0x...` (this becomes the contract owner — the game server will need this wallet)
- **Deployment Transaction Hash:** (optional, for records)

### 7. Verify Contract on LineaScan (Recommended)

```bash
npx hardhat verify --network linea <CONTRACT_ADDRESS> 0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

This publishes the source code on LineaScan for transparency.

---

## 📝 What I Need After Deployment

Send me these values (via Telegram or secure channel):

```
CONTRACT_ADDRESS=0x...
DEPLOYER_ADDRESS=0x...
DEPLOYMENT_TX_HASH=0x... (optional)
```

I'll update:
- `packages/backend/.env`
- `packages/frontend/.env`

---

## 🔒 Security Notes

### Contract Owner
- The deployer wallet becomes the **contract owner**
- Owner can:
  - Complete/reject withdrawals
  - Pause/unpause contract (emergency stop)
  - Update minimum deposit/withdrawal amounts
  - Recover accidentally sent tokens (not mUSD)

### Recommended: Transfer Ownership to Server Wallet
After deployment, you can transfer ownership to a dedicated server wallet:

```bash
# In Hardhat console or via script
await vault.transferOwnership('0x...NEW_OWNER_ADDRESS');
```

This way the game server controls withdrawals, not your personal deployer wallet.

---

## 🐛 Troubleshooting

### Error: "Insufficient funds"
- Your wallet needs ETH for gas
- Get more ETH and try again

### Error: "Invalid token address"
- Double-check `MUSD_TOKEN_ADDRESS` is correct
- Linea mainnet: `0xacA92E438df0B2401fF60dA7E4337B687a2435DA`

### Error: "Nonce too low"
- Your wallet has pending transactions
- Wait for them to confirm or reset nonce in MetaMask

### Error: "Contract already deployed"
- You already deployed at this address
- Check your transaction history
- Deploy from a different wallet or use a different nonce

### Verification Fails
- Make sure you have `LINEASCAN_API_KEY` in `.env`
- Get one from https://lineascan.build (free)
- Try manual verification on LineaScan UI

---

## 📊 Post-Deployment Checks

1. **View contract on LineaScan:**  
   https://lineascan.build/address/<CONTRACT_ADDRESS>

2. **Check owner:**  
   Should be your deployer wallet

3. **Check token:**  
   Should be `0xacA92E438df0B2401fF60dA7E4337B687a2435DA`

4. **Check minimum amounts:**  
   - minDepositAmount: 1000000 (1 mUSD with 6 decimals)
   - minWithdrawalAmount: 1000000 (1 mUSD with 6 decimals)

5. **Check paused:**  
   Should be `false` (contract active)

---

## 🎯 Next Steps After Deployment

1. Send me contract address
2. I'll update backend + frontend `.env` files
3. I'll implement the blockchain listener (watches deposit events)
4. We test deposit flow on testnet first
5. Then switch to mainnet for production

---

## 📞 Need Help?

Message me on Telegram (@ShaunCE) if you hit any issues. Include:
- Error message (full output)
- Which network (testnet/mainnet)
- Your deployer address (not private key!)

---

**Ready to deploy when you are!** 🚀
