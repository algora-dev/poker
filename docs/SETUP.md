# Setup Guide

Complete setup instructions for the poker game project.

## Prerequisites

- **Node.js:** 20.x or higher
- **npm:** 10.x or higher
- **Docker:** Latest version (for PostgreSQL)
- **Git:** Latest version
- **MetaMask:** Browser extension (for testing)

## Initial Setup

### 1. Clone Repository

```bash
git clone <repo-url>
cd poker-game
```

### 2. Install Dependencies

Install root dependencies (concurrently):

```bash
npm install
```

Install workspace dependencies:

```bash
cd packages/backend && npm install
cd ../frontend && npm install
cd ../contracts && npm install
```

### 3. Environment Configuration

#### Backend

```bash
cd packages/backend
cp .env.example .env
```

Edit `.env` and fill in:
- `DATABASE_URL` (should work with default Docker values)
- `JWT_SECRET` (generate with `openssl rand -hex 32`)
- `MUSD_TOKEN_ADDRESS` (mUSD token on Linea)
- `PRIVATE_KEY` (server wallet for contract interactions)
- Other values as needed

#### Frontend

```bash
cd packages/frontend
cp .env.example .env
```

Edit `.env` and fill in:
- `VITE_CONTRACT_ADDRESS` (after deploying contract)
- `VITE_MUSD_TOKEN_ADDRESS` (mUSD token on Linea)

#### Contracts

```bash
cd packages/contracts
cp .env.example .env
```

Edit `.env` and fill in:
- `PRIVATE_KEY` (deployer wallet)
- `MUSD_TOKEN_ADDRESS` (mUSD token on Linea)
- `LINEASCAN_API_KEY` (for contract verification, optional)

### 4. Start Database

```bash
# From project root
docker-compose up -d
```

Verify database is running:

```bash
docker ps
# Should see poker-db container running
```

### 5. Run Database Migrations

```bash
cd packages/backend
npx prisma migrate dev
```

This creates the database schema. You should see output confirming migration success.

### 6. Deploy Smart Contract

**Important:** Start with Linea Testnet (Goerli) before mainnet!

```bash
cd packages/contracts

# Compile contracts
npm run compile

# Deploy to testnet
npm run deploy:testnet

# Copy the deployed contract address
# Update both backend and frontend .env files with CONTRACT_ADDRESS
```

For mainnet deployment:

```bash
npm run deploy:mainnet
```

### 7. Verify Contract (Optional)

```bash
npm run verify:testnet <CONTRACT_ADDRESS> <MUSD_TOKEN_ADDRESS>
```

## Running the Application

### Option 1: Run All Services

From project root:

```bash
npm run dev
```

This starts both backend and frontend concurrently.

### Option 2: Run Services Individually

**Backend:**

```bash
cd packages/backend
npm run dev
```

**Frontend:**

```bash
cd packages/frontend
npm run dev
```

## Access Points

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3000
- **Socket.io:** http://localhost:3001
- **Prisma Studio:** `cd packages/backend && npm run studio`

## Testing

### Backend Tests

```bash
cd packages/backend
npm run test
```

### Contract Tests

```bash
cd packages/contracts
npm run test
```

### Frontend Tests

(TODO: Set up Vitest)

```bash
cd packages/frontend
npm run test
```

## Database Management

### Open Prisma Studio

```bash
cd packages/backend
npm run studio
```

Access at http://localhost:5555

### Create Migration

```bash
cd packages/backend
npx prisma migrate dev --name <migration_name>
```

### Reset Database

```bash
npx prisma migrate reset
```

⚠️ **Warning:** This deletes all data!

### Seed Database

(TODO: Create seed script)

```bash
npx prisma db seed
```

## Troubleshooting

### Database Connection Fails

1. Check Docker container is running: `docker ps`
2. Check DATABASE_URL in `.env`
3. Restart container: `docker-compose restart postgres`

### Contract Deployment Fails

1. Check PRIVATE_KEY has funds (ETH for gas)
2. Check RPC_URL is correct
3. Check MUSD_TOKEN_ADDRESS is valid
4. Try increasing gas limit in deploy script

### Frontend Can't Connect to Backend

1. Check backend is running on port 3000
2. Check VITE_API_URL in frontend `.env`
3. Check CORS settings in backend

### MetaMask Not Connecting

1. Check VITE_CHAIN_ID matches Linea (59144)
2. Add Linea network to MetaMask manually if needed
3. Check contract address is correct

## Next Steps

1. ✅ Project scaffolded
2. 🚧 Implement auth API (signup, login)
3. 🚧 Implement deposit flow
4. 🚧 Build game engine
5. 🚧 Create frontend UI

See [SPEC.md](../SPEC.md) for full roadmap.

## Useful Commands

```bash
# Root
npm run dev              # Start both backend + frontend
npm run build            # Build all packages
npm run test             # Run all tests
npm run docker:up        # Start database
npm run docker:down      # Stop database
npm run clean            # Remove all node_modules

# Backend
npm run dev              # Dev server with hot reload
npm run build            # Build for production
npm run start            # Run production build
npm run migrate:dev      # Create migration
npm run studio           # Open Prisma Studio

# Frontend
npm run dev              # Dev server with HMR
npm run build            # Build for production
npm run preview          # Preview production build

# Contracts
npm run compile          # Compile contracts
npm run test             # Run contract tests
npm run deploy:testnet   # Deploy to Linea testnet
npm run deploy:mainnet   # Deploy to Linea mainnet
npm run verify:testnet   # Verify on LineaScan
```

## Development Workflow

1. Pull latest changes: `git pull`
2. Install dependencies: `npm install`
3. Start database: `npm run docker:up`
4. Run migrations: `cd packages/backend && npm run migrate:dev`
5. Start dev servers: `npm run dev` (from root)
6. Make changes
7. Test changes: `npm run test`
8. Commit: `git add . && git commit -m "..."`
9. Push: `git push`

## Production Deployment

(TODO: Write production deployment guide in DEPLOYMENT.md)

1. Build all packages: `npm run build`
2. Deploy contract to mainnet
3. Update .env with production values
4. Deploy backend to VPS/cloud
5. Deploy frontend to CDN/hosting
6. Configure Nginx reverse proxy
7. Set up SSL certificates
8. Configure monitoring

---

Need help? Check [SPEC.md](../SPEC.md) or [PROJECT_STRUCTURE.md](../PROJECT_STRUCTURE.md).
