# Secrets & Configuration Values

**⚠️ DO NOT COMMIT THIS FILE TO GIT ⚠️**

This file contains generated secrets and addresses. Keep this secure.

---

## JWT Secret (Backend)

Use this value in `packages/backend/.env`:

```
JWT_SECRET=d3526e84a2f18fe2b7d34b86cf049d4aaa2fbddb06909d85d6bc1eeb86acb5e3
```

**What it does:** Signs JWT tokens for user authentication. Keep this secret — if leaked, attackers can forge login tokens.

---

## mUSD Token Address (Linea Mainnet)

Already configured in all `.env.example` files:

```
MUSD_TOKEN_ADDRESS=0xacA92E438df0B2401fF60dA7E4337B687a2435DA
```

---

## Smart Contract Address

**To be filled after Shaun deploys:**

```
CONTRACT_ADDRESS=0x...
```

Add this to:
- `packages/backend/.env`
- `packages/frontend/.env`

---

## Deployer/Owner Wallet

**To be filled after deployment:**

```
DEPLOYER_ADDRESS=0x...
```

This wallet owns the contract and can approve withdrawals.

---

## Server Wallet (Optional)

If you create a dedicated server wallet for production:

```
SERVER_WALLET_ADDRESS=0x...
SERVER_WALLET_PRIVATE_KEY=0x...  # Backend only, NEVER commit!
```

Transfer contract ownership to this wallet after deployment.

---

## Next Steps

1. ✅ JWT secret generated
2. ✅ mUSD address configured
3. ⏳ Waiting for contract deployment
4. ⏳ Update CONTRACT_ADDRESS after deployment
5. ⏳ Copy these values to actual `.env` files

---

## Security Reminders

- **Never commit `.env` files** (already in `.gitignore`)
- **Never share private keys** (Shaun keeps his, server keeps its own)
- **Store production secrets securely** (consider a secrets manager later)
- **Rotate JWT secret periodically** (invalidates all tokens, but improves security)

---

**Status:** Ready for deployment
