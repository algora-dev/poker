# Poker Game - Crypto-Enabled Texas Hold'em

Secure multiplayer poker game with crypto on/off-ramp using mUSD on Linea.

## Stack

- **Backend:** Node.js + TypeScript + Fastify + Socket.io + Prisma + PostgreSQL
- **Frontend:** React + TypeScript + Vite + TailwindCSS + Canvas
- **Blockchain:** Linea Mainnet (L2) + mUSD token
- **Contracts:** Solidity + Hardhat

## Features

- Texas Hold'em (up to 10 players per table)
- Crypto deposits/withdrawals (mUSD)
- Custom PFPs, table skins, dealer animations
- Real-time gameplay via WebSockets
- Server-authoritative (anti-cheat)
- Ledger reconciliation

## Quick Start

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- MetaMask or WalletConnect

### Setup

```bash
# Clone repo
git clone <repo-url>
cd poker-game

# Install dependencies
npm install

# Copy environment files
cp packages/backend/.env.example packages/backend/.env
cp packages/frontend/.env.example packages/frontend/.env
cp packages/contracts/.env.example packages/contracts/.env

# Edit .env files with your values

# Start database
docker-compose up -d

# Run database migrations
cd packages/backend
npx prisma migrate dev

# Deploy contract (testnet first recommended)
cd ../contracts
npx hardhat run scripts/deploy.ts --network lineaTestnet

# Start backend
cd ../backend
npm run dev

# Start frontend (new terminal)
cd ../frontend
npm run dev
```

### Access

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000
- Socket.io: http://localhost:3001

## Project Structure

```
poker-game/
├── packages/
│   ├── backend/      # Game server + API
│   ├── frontend/     # React web client
│   └── contracts/    # Smart contracts
├── docs/             # Documentation
└── docker-compose.yml
```

## Development

```bash
# Run tests
cd packages/backend && npm test
cd packages/contracts && npx hardhat test

# Database operations
cd packages/backend
npx prisma studio              # Open Prisma Studio
npx prisma migrate dev         # Create migration
npx prisma generate            # Regenerate client

# Contract operations
cd packages/contracts
npx hardhat compile            # Compile contracts
npx hardhat test               # Run tests
npx hardhat verify --network linea <address>
```

## Documentation

- [Technical Spec](../SPEC.md)
- [Project Structure](../PROJECT_STRUCTURE.md)
- [API Reference](docs/API.md) (TODO)
- [Socket Events](docs/SOCKET.md) (TODO)
- [Deployment Guide](docs/DEPLOYMENT.md) (TODO)

## Security

- All game logic runs server-side
- JWT authentication with refresh tokens
- Chip balances stored in PostgreSQL with ACID guarantees
- 6-block confirmation for deposits
- Ledger reconciliation job
- Manual/automatic withdrawal mode (config switch)

## License

MIT

## Status

🚧 **In Development** - Phase 1: Foundation
