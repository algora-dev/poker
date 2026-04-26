# Deployer Wallet Info

**⚠️ SENSITIVE - DO NOT COMMIT ⚠️**

## Wallet Details

**Private Key:** `ed1fa1fe6db69f1f039c58ae278277ec2edf7f0a647224293e49f3f29a48121f`

**Address:** Will be displayed when you run the deployment script

## Current Status

- [x] Private key configured in `packages/contracts/.env`
- [ ] Wallet funded with ETH (for gas)
- [ ] Wallet funded with mUSD (for testing deposits)
- [ ] Contract deployed to Linea Testnet
- [ ] Contract deployed to Linea Mainnet

## Gas Budget

**Testnet deployment estimate:** ~0.002 ETH  
**Mainnet deployment estimate:** ~0.002 ETH (Linea is cheap)

Keep minimal ETH in this wallet for security.

## Security Notes

- This wallet will become the **contract owner**
- Owner can approve/reject withdrawals
- Owner can pause contract in emergencies
- Store this private key securely
- Consider transferring ownership to a dedicated server wallet after testing

## Next Steps

1. Fund wallet with ETH on Linea Testnet
2. Fund wallet with mUSD for deposit testing
3. Run deployment: `cd packages/contracts && npm run deploy:testnet`
4. I'll capture the contract address and update configs
5. Test deposit flow
6. If all good, deploy to mainnet

---

**Wallet is ready. Waiting for funding...**
