# Crypto Poker MVP Plan - Human-Only Launch
**Goal:** Instant play, trustworthy, fast crypto in/out  
**Timeline:** 4-6 weeks  
**Date:** 2026-04-20

---

## Executive Summary

**What we're building:**
A fast, trustworthy crypto poker platform where users click "Play Now" and are instantly seated at a table with other humans. Focus on speed, trust, and familiar gameplay.

**What we're NOT building (yet):**
- Agents/AI players
- Creator economy
- Referral system
- Points/airdrop
- Tournaments

**Why this approach:**
1. Prove the core experience works
2. Build trust with real money first
3. Get feedback from real players
4. Validate crypto flow end-to-end
5. Then add agents to solve liquidity problem

---

## Current Status (April 20, 2026)

### ✅ What Works
- Texas Hold'em poker (2-6 players)
- mUSD deposit/withdraw on Linea
- Real-time WebSocket updates
- Side pots for all-in scenarios
- Multi-player turn rotation
- JWT authentication
- Wallet linking

### ⚠️ What's Partial
- Game creation (manual only)
- Buy-in selection (50% done)
- Admin tools (basic)

### ❌ What's Missing
- Instant play / matchmaking
- Auto-table management
- Join after game starts
- Session feedback
- Withdrawal status tracking
- Leaderboards (even simple ones)

---

## MVP Feature List (Human-Only)

### 1. Instant Play System ⭐ CRITICAL

**User Flow:**
```
1. User clicks "Play Now"
2. Selects stake level (Low/Medium/High)
3. Chooses buy-in amount (within range)
4. Instantly seated at table
5. Game starts within 15 seconds
```

**Requirements:**
- Auto-create tables when needed
- Seat players in order they join
- Start game when 2+ players seated (with countdown)
- Allow 3rd+ players to join during countdown
- Close empty tables after 2 minutes

### 2. Join After Start (Late Join)

**Rules:**
- Can join if hand hasn't reached flop yet
- Can join between hands (waiting for next deal)
- Seat must be empty
- Maximum 6 players per table
- Must post big blind on first hand

**Why this matters:**
Without agents, tables need to accept latecomers to maintain player count.

### 3. Stake Levels

**Pre-configured stakes (not user-created):**

| Level | Small Blind | Big Blind | Min Buy-In | Max Buy-In |
|-------|-------------|-----------|------------|------------|
| **Micro** | 0.01 | 0.02 | 1 | 5 |
| **Low** | 0.10 | 0.20 | 5 | 20 |
| **Medium** | 0.50 | 1.00 | 25 | 100 |
| **High** | 2.00 | 4.00 | 100 | 400 |

**Why fixed stakes:**
- Simpler matchmaking
- Faster table fills
- Familiar to poker players
- Can add custom stakes later

### 4. Table Lifecycle Management

**Auto-create rules:**
- Keep 1 "warm" table per stake level
- Create new table when current fills to 4+ players
- Maximum 3 active tables per stake level

**Auto-close rules:**
- Close table if empty for 2 minutes
- Close table if only 1 player for 5 minutes
- Refund remaining chips to players

**Table capacity:**
- Minimum 2 players to start
- Maximum 6 players per table
- Ideal 4-5 players

### 5. Fast Withdrawal UX

**Current flow (invisible):**
User requests → backend processes → blockchain confirms

**MVP improvement:**
```
1. Request withdrawal
2. Show status: "Processing..." with progress bar
3. Poll every 5 seconds for updates
4. Show confirmation count: "2/6 blocks confirmed"
5. Success: "Withdrawal complete! TX: 0x..."
```

**Add withdrawal history:**
- Last 10 withdrawals
- Status (pending/confirmed/failed)
- TX hash links to Lineascan

### 6. Session Feedback

**After leaving table:**
```
┌─────────────────────────────────────┐
│        Session Summary              │
├─────────────────────────────────────┤
│ Duration: 45 minutes                │
│ Hands Played: 87                    │
│ Starting Chips: 10.00               │
│ Ending Chips: 14.50                 │
│ Profit: +4.50 (45%)                 │
│                                     │
│ Best Hand: Full House, Kings        │
│ Biggest Pot Won: 8.20               │
├─────────────────────────────────────┤
│ [View Hand History] [Play Again]    │
└─────────────────────────────────────┘
```

### 7. Trust Indicators

**Show on every screen:**
- Current chip balance (always visible)
- Withdraw button (always available)
- "No fees" or "0.5% rake" clearly stated
- "Instant withdrawals" messaging

**Add transparency:**
- Player count indicator (X players online now)
- Average withdrawal time (e.g., "< 5 minutes")
- Total wagered today/week (builds trust)

### 8. Polish Existing Features

**Fix from April 13th:**
- Complete variable buy-in UI
- Test 3+ player games thoroughly
- Fix any showdown modal issues
- Verify side pots work correctly

**Add safety rails:**
- Confirm before large buy-ins (> $50)
- Confirm before large bets (> 50% of stack)
- Auto-logout after 2 hours idle
- Session timeout warnings

---

## Architecture Changes for MVP

### Current Architecture
```
┌──────────────┐
│   Frontend   │ (React + Vite)
└──────┬───────┘
       │
┌──────▼───────┐
│   Backend    │ (Node.js monolith)
│              │
│ - Auth       │
│ - Wallet     │
│ - Game       │
│ - Socket.io  │
└──────┬───────┘
       │
┌──────▼───────┐
│  PostgreSQL  │
└──────────────┘
```

### MVP Architecture (Keep It Simple)
```
┌──────────────┐
│   Frontend   │ (React + Vite)
└──────┬───────┘
       │
┌──────▼───────────────────────┐
│        Backend Monolith      │
│                              │
│ ┌────────────────────────┐  │
│ │   HTTP API Layer       │  │
│ └────────────────────────┘  │
│                              │
│ ┌────────────────────────┐  │
│ │  Service Layer         │  │
│ │                        │  │
│ │  - Auth Service        │  │
│ │  - Wallet Service      │  │
│ │  - Game Service        │  │
│ │  - Matchmaking Service │ ← NEW
│ │  - Table Manager       │ ← NEW
│ │  - Session Service     │ ← NEW
│ │  - Admin Service       │  │
│ └────────────────────────┘  │
│                              │
│ ┌────────────────────────┐  │
│ │  Socket.io Layer       │  │
│ └────────────────────────┘  │
└──────┬───────────────────────┘
       │
┌──────▼───────────────────────┐
│  PostgreSQL + Redis (later)  │
└──────────────────────────────┘
```

**Key principle:** Monolith with clear service boundaries. Each service can be extracted later if needed.

### New Services to Add

#### Matchmaking Service (`src/services/matchmaking.ts`)
```typescript
// Responsibilities:
- acceptPlayNowRequest(userId, stakeLevel, buyInAmount)
- findAvailableTable(stakeLevel)
- createNewTable(stakeLevel)
- seatPlayer(userId, tableId, buyInAmount)
- startTableIfReady(tableId)

// Data structures:
- Queue: { userId, stakeLevel, buyInAmount, timestamp }
- Available tables by stake level
```

#### Table Manager Service (`src/services/tableManager.ts`)
```typescript
// Responsibilities:
- autoCreateTables() // Keep warm tables ready
- autoCloseTables() // Clean up empty tables
- getTableHealth(tableId) // Player count, last activity
- allowLateJoin(tableId, userId) // Check if can join
- removeInactivePlayers(tableId) // Timeout handling

// Background jobs:
- Run every 30 seconds
- Check for empty tables
- Create warm tables
- Remove idle players
```

#### Session Service (`src/services/session.ts`)
```typescript
// Responsibilities:
- trackHandPlayed(userId, handId, result)
- getSessionSummary(userId, tableId)
- getBestHands(userId, limit)
- getHandHistory(userId, limit)

// Data:
- Session stats (duration, hands, profit)
- Best hands cache
- Recent activity
```

### Database Schema Additions

```sql
-- Stake levels (predefined)
CREATE TABLE stake_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL UNIQUE, -- "micro", "low", "medium", "high"
  small_blind BIGINT NOT NULL,
  big_blind BIGINT NOT NULL,
  min_buy_in BIGINT NOT NULL,
  max_buy_in BIGINT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  sort_order INT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Insert default stakes
INSERT INTO stake_levels (name, small_blind, big_blind, min_buy_in, max_buy_in, sort_order) VALUES
('micro', 10000, 20000, 1000000, 5000000, 1),
('low', 100000, 200000, 5000000, 20000000, 2),
('medium', 500000, 1000000, 25000000, 100000000, 3),
('high', 2000000, 4000000, 100000000, 400000000, 4);

-- Update Game table
ALTER TABLE "Game" ADD COLUMN stake_level_id UUID REFERENCES stake_levels(id);
ALTER TABLE "Game" ADD COLUMN auto_created BOOLEAN DEFAULT false;
ALTER TABLE "Game" ADD COLUMN last_activity TIMESTAMP DEFAULT NOW();
ALTER TABLE "Game" ADD COLUMN allow_late_join BOOLEAN DEFAULT true;

-- Matchmaking queue (optional, can start without)
CREATE TABLE matchmaking_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  stake_level_id UUID NOT NULL REFERENCES stake_levels(id),
  buy_in_amount BIGINT NOT NULL,
  status VARCHAR(20) DEFAULT 'waiting', -- waiting, matched, cancelled
  created_at TIMESTAMP DEFAULT NOW(),
  matched_at TIMESTAMP,
  table_id UUID REFERENCES games(id)
);
CREATE INDEX idx_queue_active ON matchmaking_queue(status, stake_level_id, created_at);

-- Session tracking
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  table_id UUID NOT NULL REFERENCES games(id),
  seat_number INT NOT NULL,
  buy_in_amount BIGINT NOT NULL,
  ending_amount BIGINT,
  hands_played INT DEFAULT 0,
  biggest_pot_won BIGINT DEFAULT 0,
  best_hand_rank INT,
  best_hand_name VARCHAR(100),
  profit BIGINT DEFAULT 0,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id, started_at DESC);

-- Withdrawal tracking (enhance existing)
ALTER TABLE withdrawals ADD COLUMN confirmations INT DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN estimated_completion TIMESTAMP;
ALTER TABLE withdrawals ADD COLUMN user_notified BOOLEAN DEFAULT false;
```

### Code Structure for Agent-Readiness

**Even though we're not building agents now, structure code to make adding them easy:**

```typescript
// src/services/game.ts

// Current: Hardcoded to require humans
export async function canStartGame(game: Game): Promise<boolean> {
  const humanPlayers = game.players.filter(p => p.userId !== null);
  return humanPlayers.length >= 2;
}

// Future-ready: Interface-based
export async function canStartGame(game: Game): Promise<boolean> {
  const activePlayers = game.players.filter(p => p.isActive);
  const humanPlayers = activePlayers.filter(p => p.playerType === 'human');
  
  // MVP: Require 2+ humans
  if (humanPlayers.length < 2) return false;
  
  // Future: Allow agents to fill
  // if (activePlayers.length >= 2) return true;
  
  return true;
}
```

**Add player type field (prepared for agents):**
```sql
ALTER TABLE game_players ADD COLUMN player_type VARCHAR(20) DEFAULT 'human';
-- Future values: 'human', 'agent', 'bot'
```

**Interface for player actions:**
```typescript
// src/services/playerActions.ts

export interface PlayerDecision {
  playerId: string;
  action: 'fold' | 'check' | 'call' | 'raise' | 'all-in';
  amount?: bigint;
}

// Human player (current)
export async function getHumanDecision(
  playerId: string,
  gameState: GameState
): Promise<PlayerDecision> {
  // Wait for WebSocket action from frontend
  return await waitForPlayerAction(playerId);
}

// Agent player (future)
export async function getAgentDecision(
  playerId: string,
  gameState: GameState
): Promise<PlayerDecision> {
  // Call agent service
  // return await agentService.decideAction(playerId, gameState);
  throw new Error('Agents not implemented');
}

// Unified interface
export async function getPlayerDecision(
  player: GamePlayer,
  gameState: GameState
): Promise<PlayerDecision> {
  if (player.playerType === 'human') {
    return await getHumanDecision(player.id, gameState);
  } else if (player.playerType === 'agent') {
    return await getAgentDecision(player.id, gameState);
  }
  throw new Error(`Unknown player type: ${player.playerType}`);
}
```

**This structure allows adding agents later without rewriting game logic.**

---

## Implementation Plan (4-6 Weeks)

### Week 1: Foundation & Polish
**Goal:** Complete partial features, add stake levels

**Tasks:**
- [ ] Complete variable buy-in UI from April 13th
- [ ] Test 3+ player games thoroughly
- [ ] Fix any showdown/side pot bugs
- [ ] Add stake levels table and seed data
- [ ] Update Game schema with stake_level_id
- [ ] Add session tracking schema

**Deliverable:** Rock-solid game engine, ready for matchmaking

**Time:** 5 days (40 hours)

### Week 2: Matchmaking Service
**Goal:** "Play Now" button works

**Tasks:**
- [ ] Create matchmaking service (src/services/matchmaking.ts)
- [ ] Implement findAvailableTable logic
- [ ] Implement seatPlayer logic
- [ ] Add countdown timer before game start
- [ ] Build Play Now UI (frontend)
- [ ] Add stake level selection screen
- [ ] Test instant seating flow

**Deliverable:** Users can click Play Now and get seated

**Time:** 5 days (40 hours)

### Week 3: Table Management
**Goal:** Auto-create/close tables, late join

**Tasks:**
- [ ] Create table manager service (src/services/tableManager.ts)
- [ ] Implement auto-create warm tables (background job)
- [ ] Implement auto-close empty tables (background job)
- [ ] Add late join logic (before flop, between hands)
- [ ] Add player timeout detection (30s + 30s grace)
- [ ] Test table lifecycle end-to-end

**Deliverable:** Tables manage themselves, players can join late

**Time:** 5 days (40 hours)

### Week 4: Trust & UX
**Goal:** Withdrawal tracking, session feedback, polish

**Tasks:**
- [ ] Build withdrawal status page
- [ ] Add confirmation count display
- [ ] Implement session tracking service
- [ ] Build session summary modal
- [ ] Add hand history viewer (simple table)
- [ ] Add trust indicators (player count, avg withdrawal time)
- [ ] Polish UI/UX (loading states, error messages)

**Deliverable:** Users trust the platform, see clear feedback

**Time:** 5 days (40 hours)

### Week 5: Testing & Bug Fixes
**Goal:** Everything works reliably

**Tasks:**
- [ ] End-to-end testing (deposit → play → withdraw)
- [ ] Load testing (simulate 10 concurrent games)
- [ ] Bug fixes from testing
- [ ] Performance optimization (if needed)
- [ ] Security audit (basic - input validation, auth checks)
- [ ] Write admin runbook (how to handle issues)

**Deliverable:** Production-ready MVP

**Time:** 5 days (40 hours)

### Week 6: Beta Launch Prep
**Goal:** Soft launch with friends/testers

**Tasks:**
- [ ] Deploy to production environment
- [ ] Set up monitoring (error tracking, uptime)
- [ ] Create user onboarding flow (first-time UX)
- [ ] Write help docs (how to play, how to withdraw, FAQ)
- [ ] Invite 10-20 beta testers
- [ ] Monitor for issues, fix critical bugs

**Deliverable:** Live beta with real users

**Time:** 5 days (40 hours)

**Total:** 30 days (240 hours) = 6 weeks

---

## Technical Details: Instant Play Flow

### Frontend Flow
```typescript
// src/pages/PlayNow.tsx

function PlayNowPage() {
  const [stakeLevel, setStakeLevel] = useState<string>('low');
  const [buyInAmount, setBuyInAmount] = useState<number>(10);
  
  const handlePlayNow = async () => {
    try {
      // Call matchmaking API
      const response = await api.post('/api/matchmaking/play-now', {
        stakeLevel,
        buyInAmount,
      });
      
      const { tableId, seatNumber } = response.data;
      
      // Navigate to game room
      navigate(`/game/${tableId}`);
      
    } catch (error) {
      // Show error (insufficient balance, etc.)
      showError(error.message);
    }
  };
  
  return (
    <div>
      <h1>Play Now</h1>
      
      {/* Stake level selector */}
      <StakeLevelSelector 
        value={stakeLevel} 
        onChange={setStakeLevel} 
      />
      
      {/* Buy-in amount */}
      <BuyInInput
        min={getMinBuyIn(stakeLevel)}
        max={getMaxBuyIn(stakeLevel)}
        value={buyInAmount}
        onChange={setBuyInAmount}
      />
      
      {/* Play button */}
      <button onClick={handlePlayNow}>
        Play Now
      </button>
    </div>
  );
}
```

### Backend Flow
```typescript
// src/api/matchmaking/index.ts

fastify.post('/play-now', async (request, reply) => {
  const { stakeLevel, buyInAmount } = request.body;
  const userId = request.user!.id;
  
  // 1. Validate user has enough chips
  const balance = await getChipBalance(userId);
  if (balance < buyInAmount) {
    return reply.code(400).send({ error: 'Insufficient balance' });
  }
  
  // 2. Find or create table
  let table = await matchmakingService.findAvailableTable(stakeLevel);
  
  if (!table) {
    table = await matchmakingService.createNewTable(stakeLevel);
  }
  
  // 3. Seat player
  const seat = await matchmakingService.seatPlayer(
    userId,
    table.id,
    buyInAmount
  );
  
  // 4. Deduct chips from balance
  await deductChips(userId, buyInAmount);
  
  // 5. Start game if ready (2+ players)
  if (table.playerCount >= 2) {
    await matchmakingService.startTableIfReady(table.id);
  }
  
  // 6. Return table info
  return reply.send({
    tableId: table.id,
    seatNumber: seat.seatNumber,
    playerCount: table.playerCount,
  });
});
```

### Matchmaking Service Implementation
```typescript
// src/services/matchmaking.ts

export async function findAvailableTable(
  stakeLevel: string
): Promise<Game | null> {
  // Find table with:
  // - Matching stake level
  // - Status = 'waiting' or 'in_progress' (if late join allowed)
  // - Player count < 6
  // - Last activity < 5 minutes ago (not stale)
  
  const table = await prisma.game.findFirst({
    where: {
      stakeLevel: { name: stakeLevel },
      status: { in: ['waiting', 'in_progress'] },
      players: { length: { lt: 6 } },
      allowLateJoin: true,
      lastActivity: { gt: new Date(Date.now() - 5 * 60 * 1000) },
    },
    include: { players: true },
  });
  
  return table;
}

export async function createNewTable(
  stakeLevel: string
): Promise<Game> {
  const stakeLevelConfig = await prisma.stakeLevel.findUnique({
    where: { name: stakeLevel },
  });
  
  const table = await prisma.game.create({
    data: {
      name: `Auto Table ${Date.now()}`,
      stakeLevelId: stakeLevelConfig.id,
      smallBlind: stakeLevelConfig.smallBlind,
      bigBlind: stakeLevelConfig.bigBlind,
      minBuyIn: stakeLevelConfig.minBuyIn,
      maxBuyIn: stakeLevelConfig.maxBuyIn,
      status: 'waiting',
      autoCreated: true,
      allowLateJoin: true,
      maxPlayers: 6,
    },
  });
  
  logger.info('Auto-created table', { tableId: table.id, stakeLevel });
  
  return table;
}

export async function seatPlayer(
  userId: string,
  tableId: string,
  buyInAmount: bigint
): Promise<GamePlayer> {
  // Find next available seat
  const existingPlayers = await prisma.gamePlayer.findMany({
    where: { gameId: tableId },
  });
  
  const occupiedSeats = existingPlayers.map(p => p.seatIndex);
  const nextSeat = findNextAvailableSeat(occupiedSeats, 6);
  
  // Create game player
  const player = await prisma.gamePlayer.create({
    data: {
      gameId: tableId,
      userId,
      seatIndex: nextSeat,
      chipStack: buyInAmount,
      position: 'waiting',
      playerType: 'human',
    },
  });
  
  // Update table last activity
  await prisma.game.update({
    where: { id: tableId },
    data: { lastActivity: new Date() },
  });
  
  // Create session record
  await prisma.userSession.create({
    data: {
      userId,
      tableId,
      seatNumber: nextSeat,
      buyInAmount,
    },
  });
  
  logger.info('Player seated', { userId, tableId, seatNumber: nextSeat });
  
  return player;
}

export async function startTableIfReady(tableId: string) {
  const table = await prisma.game.findUnique({
    where: { id: tableId },
    include: { players: true },
  });
  
  if (!table) return;
  
  // Check if should start
  const humanPlayers = table.players.filter(p => p.playerType === 'human');
  
  if (humanPlayers.length < 2) {
    // Not enough players yet
    return;
  }
  
  if (table.status === 'in_progress') {
    // Already started
    return;
  }
  
  // Start game after 10-second countdown
  setTimeout(async () => {
    // Double-check player count (in case someone left)
    const updatedTable = await prisma.game.findUnique({
      where: { id: tableId },
      include: { players: true },
    });
    
    const currentHumans = updatedTable.players.filter(
      p => p.playerType === 'human'
    );
    
    if (currentHumans.length >= 2) {
      await prisma.game.update({
        where: { id: tableId },
        data: {
          status: 'in_progress',
          startedAt: new Date(),
        },
      });
      
      // Initialize first hand
      await initializeHand(tableId);
      
      // Emit game started event
      emitGameEvent(tableId, 'game:started', { tableId });
      
      logger.info('Table started', { tableId, playerCount: currentHumans.length });
    }
  }, 10000); // 10-second countdown
}

function findNextAvailableSeat(occupiedSeats: number[], maxSeats: number): number {
  for (let i = 0; i < maxSeats; i++) {
    if (!occupiedSeats.includes(i)) {
      return i;
    }
  }
  throw new Error('No available seats');
}
```

### Table Manager Background Job
```typescript
// src/services/tableManager.ts

// Run every 30 seconds
setInterval(async () => {
  await maintainTables();
}, 30000);

async function maintainTables() {
  // 1. Close empty tables
  await closeEmptyTables();
  
  // 2. Close stale tables (1 player for 5+ minutes)
  await closeStaleT tables();
  
  // 3. Ensure warm tables exist
  await ensureWarmTables();
  
  // 4. Remove inactive players
  await removeInactivePlayers();
}

async function closeEmptyTables() {
  const emptyTables = await prisma.game.findMany({
    where: {
      status: 'waiting',
      players: { none: {} },
      autoCreated: true,
      createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) }, // > 2 min old
    },
  });
  
  for (const table of emptyTables) {
    await prisma.game.update({
      where: { id: table.id },
      data: { status: 'cancelled' },
    });
    
    logger.info('Closed empty table', { tableId: table.id });
  }
}

async function closeStale Tables() {
  const staleTables = await prisma.game.findMany({
    where: {
      status: { in: ['waiting', 'in_progress'] },
      lastActivity: { lt: new Date(Date.now() - 5 * 60 * 1000) }, // No activity 5+ min
    },
    include: { players: true },
  });
  
  for (const table of staleTables) {
    if (table.players.length <= 1) {
      // Refund remaining player
      for (const player of table.players) {
        await refundPlayer(player);
      }
      
      await prisma.game.update({
        where: { id: table.id },
        data: { status: 'cancelled' },
      });
      
      logger.info('Closed stale table', { tableId: table.id });
    }
  }
}

async function ensureWarmTables() {
  const stakeLevels = await prisma.stakeLevel.findMany({
    where: { enabled: true },
  });
  
  for (const level of stakeLevels) {
    // Check if warm table exists
    const warmTable = await prisma.game.findFirst({
      where: {
        stakeLevelId: level.id,
        status: 'waiting',
        autoCreated: true,
        players: { length: { eq: 0 } },
      },
    });
    
    if (!warmTable) {
      // Create warm table
      await matchmakingService.createNewTable(level.name);
      logger.info('Created warm table', { stakeLevel: level.name });
    }
  }
}

async function removeInactivePlayers() {
  // Find players who haven't acted in 60+ seconds during their turn
  // (This requires tracking turn start time in game state)
  
  const inactivePlayers = await prisma.gamePlayer.findMany({
    where: {
      position: 'active',
      // Add logic to check turn timeout
    },
  });
  
  for (const player of inactivePlayers) {
    // Auto-fold and mark as inactive
    await processAction(player.gameId, player.userId, 'fold');
    
    logger.warn('Removed inactive player', { 
      playerId: player.id, 
      userId: player.userId 
    });
  }
}

async function refundPlayer(player: GamePlayer) {
  await prisma.chipBalance.update({
    where: { userId: player.userId },
    data: {
      chips: { increment: player.chipStack },
    },
  });
  
  await prisma.chipAudit.create({
    data: {
      userId: player.userId,
      operation: 'game_refund',
      amountDelta: player.chipStack,
      reference: player.gameId,
      notes: 'Table closed due to inactivity',
    },
  });
  
  logger.info('Refunded player', { 
    userId: player.userId, 
    amount: player.chipStack 
  });
}
```

---

## UI/UX Mockups

### Landing Page
```
┌────────────────────────────────────────┐
│  🎰 Crypto Poker                       │
│  Fast. Fair. Real Money.               │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │                                  │ │
│  │   [🚀 PLAY NOW]                  │ │
│  │   Get seated in < 10 seconds     │ │
│  │                                  │ │
│  └──────────────────────────────────┘ │
│                                        │
│  💰 Deposit   📤 Withdraw   📊 Stats  │
│                                        │
│  🟢 42 players online now              │
│  ⚡ Average withdrawal: 4 minutes      │
└────────────────────────────────────────┘
```

### Play Now Screen
```
┌────────────────────────────────────────┐
│  Select Stake Level                    │
│                                        │
│  ○ Micro    ($0.01/$0.02)             │
│  ● Low      ($0.10/$0.20)  ← Selected │
│  ○ Medium   ($0.50/$1.00)             │
│  ○ High     ($2.00/$4.00)             │
│                                        │
│  Buy-In Amount:                        │
│  ┌────────────────────────────────┐   │
│  │ [5] ──●─────────────────── [20]│   │
│  └────────────────────────────────┘   │
│  Selected: $10.00                      │
│                                        │
│  Your Balance: $45.50                  │
│                                        │
│  [Continue]                            │
└────────────────────────────────────────┘
```

### Waiting for Players
```
┌────────────────────────────────────────┐
│  Finding Players...                    │
│                                        │
│  ┌────────────────────────────────┐   │
│  │         ⏱️ 00:03               │   │
│  │                                │   │
│  │  Seat 1: You ✓                │   │
│  │  Seat 2: [Waiting...]         │   │
│  │  Seat 3: [Empty]              │   │
│  │  Seat 4: [Empty]              │   │
│  │  Seat 5: [Empty]              │   │
│  │  Seat 6: [Empty]              │   │
│  │                                │   │
│  │  Game starts when 2+ players  │   │
│  └────────────────────────────────┘   │
│                                        │
│  [Leave Table]                         │
└────────────────────────────────────────┘
```

### Game Starting Countdown
```
┌────────────────────────────────────────┐
│  Game Starting in...                   │
│                                        │
│  ┌────────────────────────────────┐   │
│  │            5                   │   │
│  │         seconds                │   │
│  │                                │   │
│  │  Seat 1: You ✓                │   │
│  │  Seat 2: Player2 ✓            │   │
│  │  Seat 3: [Joining...]         │   │
│  │  Seat 4: [Empty]              │   │
│  └────────────────────────────────┘   │
│                                        │
│  More players can join!                │
└────────────────────────────────────────┘
```

### Session Summary (After Leaving)
```
┌────────────────────────────────────────┐
│  Session Complete                      │
│                                        │
│  Duration: 45 minutes                  │
│  Hands Played: 87                      │
│                                        │
│  ┌────────────────────────────────┐   │
│  │  Starting: $10.00              │   │
│  │  Ending:   $14.50              │   │
│  │  ─────────────────             │   │
│  │  Profit:   +$4.50 (45%)  ✅   │   │
│  └────────────────────────────────┘   │
│                                        │
│  Best Hand: Full House, Kings          │
│  Biggest Pot: $8.20                    │
│                                        │
│  [View Hand History]  [Play Again]     │
└────────────────────────────────────────┘
```

---

## Success Metrics for MVP

### Technical Metrics
- **Time to first hand:** < 15 seconds (target: < 10s)
- **Uptime:** > 99% (< 1% downtime)
- **Crash rate:** < 0.1% of hands
- **Average withdrawal time:** < 10 minutes (target: < 5 min)

### User Metrics
- **Deposit completion rate:** > 80% (users who start deposit, complete it)
- **First hand completion rate:** > 90% (users who join, play at least 1 hand)
- **Return rate (D1):** > 30% (users who come back next day)
- **Average session duration:** > 20 minutes

### Business Metrics
- **Active tables:** Average 2-5 tables with humans
- **Player count:** 20-50 daily active users (beta target)
- **Total wagered:** Track for trust signals
- **Support tickets:** < 10% of users

---

## Risk Mitigation

### Risk: Empty Tables (Cold Start Problem)
**Mitigation:**
- Launch with coordinated timing (announce time, everyone joins at once)
- Invite 10-20 testers who commit to specific times
- Consider temporary faucet (free chips) for beta testers
- Set expectations: "Beta - play with friends, schedule games"

### Risk: Users Don't Trust Crypto Withdrawals
**Mitigation:**
- Show real-time status (confirmation count)
- Link to blockchain explorer (transparent)
- Start with small stakes ($1-10 tables only)
- Test with beta users withdrawing small amounts first
- Consider instant withdrawal for amounts < $10 (manual approval, pre-funded)

### Risk: Bugs in Poker Logic
**Mitigation:**
- Extensive testing before launch (100+ hands)
- Clear hand history (users can report issues)
- Refund policy for confirmed bugs
- Test all edge cases (all-in, side pots, ties)

### Risk: No One Joins
**Mitigation:**
- This is THE reason we need agents after MVP
- For MVP: Coordinate launch, invite committed testers
- Consider soft launch with friends/community first
- If no traction after 2 weeks, add agents immediately

---

## Post-MVP: Adding Agents

**Once MVP proves the core game works, adding agents will take 3-4 weeks:**

### What Changes:
1. **Agent Service** (new package)
   - Simple rule-based AI
   - 2-3 personality types
   - Connect via internal API

2. **Matchmaking Logic**
   - If < 2 humans after 15 seconds, add 1-2 agents
   - Keep agent/human ratio 50-70% agents max
   - Priority: humans fill first, agents backfill

3. **UI Updates**
   - Show "🤖" indicator for agents
   - Player stats show "vs humans" and "vs agents" separately

4. **Database**
   - Agent profiles table
   - Agent sessions tracking
   - Already have player_type field ready

### Why This Approach Works:
- MVP proves game + crypto + matchmaking works
- If MVP fails, we didn't waste time on agents
- If MVP succeeds, adding agents is straightforward (already designed for it)
- Agents solve cold start after we validate demand

---

## Budget & Timeline Summary

### Development Time
**Week 1:** Foundation & Polish (40 hours)  
**Week 2:** Matchmaking Service (40 hours)  
**Week 3:** Table Management (40 hours)  
**Week 4:** Trust & UX (40 hours)  
**Week 5:** Testing & Fixes (40 hours)  
**Week 6:** Beta Launch (40 hours)  

**Total:** 240 hours (6 weeks)

### Cost Estimate
| Role | Rate | Hours | Cost |
|------|------|-------|------|
| Development (me) | $100/hr | 240 hrs | $24,000 |
| Design/UX | $80/hr | 20 hrs | $1,600 |
| QA Testing | $50/hr | 20 hrs | $1,000 |
| **Total** | | 280 hrs | **$26,600** |

### Infrastructure (Monthly)
- AWS/Cloud hosting: $200
- PostgreSQL (managed): $50
- Domain + SSL: $20
- Monitoring: $50
- **Total:** $320/month

### MVP Budget: ~$27,000 + $320/mo

---

## Launch Checklist

### Pre-Launch (1 week before)
- [ ] All features tested end-to-end
- [ ] Performance testing (10 concurrent games)
- [ ] Security audit (basic)
- [ ] Legal disclaimer drafted
- [ ] Terms of service + privacy policy
- [ ] Beta tester list (10-20 people)
- [ ] Support email/Discord set up
- [ ] Monitoring/alerts configured

### Launch Day
- [ ] Deploy to production
- [ ] Send invites to beta testers
- [ ] Announce launch time (coordinate)
- [ ] Monitor for errors/crashes
- [ ] Be available for support

### Week 1 Post-Launch
- [ ] Daily check-ins with users
- [ ] Fix critical bugs immediately
- [ ] Collect feedback (surveys, interviews)
- [ ] Track metrics (see Success Metrics)
- [ ] Decide: continue with humans-only, or add agents?

---

## Next Steps

**This week:**
1. Review this plan with team
2. Confirm timeline and budget
3. Set up project tracking (Trello/Linear/etc.)
4. Commit to start date

**Next week:**
5. Start Week 1 tasks (finish buy-ins, add stake levels)

**Questions to answer:**
- Who is coding this? (Me full-time, or team?)
- What's the actual deadline? (Flexible or hard date?)
- What's the beta tester recruitment plan?
- Should we get legal review before launch?

---

**Ready to start? Let me know if you want me to dive deeper into any section or if we should start coding Week 1 tasks.**
