# Crypto Poker Network - Architecture Analysis & Implementation Plan

**Date:** 2026-04-20  
**Analyst:** Dave  
**Current Status:** MVP poker engine built (April 13, 2026)

---

## Executive Summary

**Vision:** Agent-powered liquidity network for crypto poker with multiple earning paths

**Current State:** We have a working Texas Hold'em engine with crypto on/off-ramp. **We're ~20% of the way to Phase 1 MVP.**

**Key Gap:** No agent system (the core differentiator)

**Recommendation:** Focus on "instant play" UX + basic agents before anything else. Defer creator economy and points until liquidity problem is solved.

---

## 1. What We've Already Built (April 13, 2026)

### ✅ Core Game Engine (70% of Phase 1 "Simple Table Engine")
- Full Texas Hold'em mechanics
- Betting rounds (preflop, flop, turn, river, showdown)
- Side pots for all-in scenarios
- Multi-player support (2-6 players)
- Turn timers (30 seconds)
- Hand evaluation and winner determination

### ✅ Blockchain Integration (100% of Phase 1 "Wallet + Chips Flow")
- mUSD (Linea Mainnet) deposit/withdrawal
- Smart contract custody (Vault: 0x41DE...)
- 6-block confirmation before chip credit
- Internal chip ledger (dual-balance model)
- Chip audit trail (ChipAudit table)

### ✅ Real-Time Infrastructure (Phase 1 "Game Speed Optimization")
- Socket.io WebSocket transport
- Live game state updates
- Turn notifications (audio + visual + desktop)
- Balance updates pushed to clients

### ✅ Basic Data Layer
- PostgreSQL for transactional data
- Game/GamePlayer/Hand/HandAction/SidePot tables
- User authentication (JWT)
- Wallet linking with signature verification

### ⚠️ Partial Features
- **Game creation:** Manual only (no auto-create/close)
- **Matchmaking:** None (players manually join games)
- **Admin tools:** Basic cleanup, no abuse detection
- **Table management:** No stakes configuration, no visibility controls

### ❌ Missing Core Features
- **Instant Play UX** - No "Play Now" button
- **Basic Agents** - Zero agent system
- **Auto-seat flow** - No matchmaking
- **Table transparency** - Can't see humans vs agents
- **Session feedback** - No stats or results screen
- **Anti-abuse** - Basic only
- **Withdrawal tracking** - Status not visible

---

## 2. Gap Analysis by Phase

### Phase 1 - Core Game + Liquidity (MVP Launch)
**Status:** 40% complete

| Feature | Status | Effort | Priority |
|---------|--------|--------|----------|
| Instant Play UX | ❌ None | 2 weeks | 🔴 CRITICAL |
| Simple Table Engine | ⚠️ 70% | 1 week | 🟡 MEDIUM |
| Basic Agents | ❌ None | 4 weeks | 🔴 CRITICAL |
| Wallet + Chips | ✅ Done | - | ✅ COMPLETE |
| Game Speed | ✅ Good | - | ✅ COMPLETE |

**Biggest Blockers:**
1. No agent system (4 weeks to build)
2. No matchmaking service (2 weeks)
3. No auto-table management (1 week)

### Phase 2 - Retention + Trust
**Status:** 0% complete (blocked by Phase 1)

All features missing:
- Table transparency UI
- Session feedback screens
- Withdrawal status tracking
- Basic anti-abuse monitoring

**Estimated effort:** 3 weeks (after Phase 1)

### Phase 3 - Table Creator Economy
**Status:** 5% complete (can create tables, but no incentives)

Missing:
- Revenue share system
- Referral tracking
- Creator leaderboard
- Rake distribution logic

**Estimated effort:** 4 weeks (after Phase 2)

### Phase 4-6
**Status:** Not started (defer until v1 proven)

---

## 3. Technical Architecture: Current vs Desired

### 3.1 What Aligns Well

| Component | Current | Desired | Status |
|-----------|---------|---------|--------|
| Client | React + Vite | Web client | ✅ Match |
| Backend | Node.js/TypeScript | Node.js/TypeScript | ✅ Match |
| Database | PostgreSQL | PostgreSQL | ✅ Match |
| Real-time | Socket.io | WebSocket | ✅ Match |
| Smart contracts | Solidity | Stablecoin custody | ✅ Match |
| Dual ledger | Implemented | Recommended | ✅ Match |

### 3.2 What Needs Adjustment

| Component | Current | Desired | Gap |
|-----------|---------|---------|-----|
| Architecture | Monolith | Microservices | 🟡 Acceptable for MVP |
| Cache layer | None | Redis | 🔴 Will need for scale |
| Agent system | None | Separate service | 🔴 Must build |
| Matchmaking | None | Dedicated service | 🔴 Must build |
| Analytics | None | Telemetry service | 🟡 Can defer |
| Admin tools | Basic | Risk service | 🟡 Expand gradually |

### 3.3 Service Boundaries (Future State)

The architecture doc suggests splitting into services:

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
┌──────▼──────────────────────────────┐
│         API Gateway / Router        │
└─────────────────┬───────────────────┘
                  │
      ┌───────────┴───────────┐
      │                       │
┌─────▼─────┐         ┌───────▼────────┐
│   Auth    │         │  Wallet/Ledger │
│  Service  │         │    Service     │
└───────────┘         └────────────────┘
      │                       │
      │               ┌───────▼────────┐
      │               │  Matchmaking   │
      │               │    Service     │
      │               └───────┬────────┘
      │                       │
      │               ┌───────▼────────┐
      │               │   Game Server  │
      │               │  (Poker Engine)│
      │               └───────┬────────┘
      │                       │
      │               ┌───────▼────────┐
      │               │     Agent      │
      │               │ Orchestration  │
      │               └────────────────┘
      │
┌─────▼─────────────────────────────┐
│  Rewards / Referral / Leaderboard │
└───────────────────────────────────┘
```

**Current State:** Everything is in one Node.js server.

**Recommendation:** Keep monolith for now, but structure code into clear modules that can be extracted later. Use Redis as the bridge when we need to scale.

---

## 4. Critical Missing Component: Agent System

### 4.1 What Agents Need to Do (Per Roadmap)

**Phase 1 Requirements:**
- 2-3 agent types (e.g., "Tight", "Aggressive", "Calling Station")
- Fill empty seats automatically
- Max agents per table (suggested 50-70% agent, 30-50% human)
- Human-like, imperfect play
- Fast decisions (no lag)

**Phase 4 Requirements (Later):**
- User-owned agents
- 2 traits (1 visible, 1 hidden)
- Configurable duration and stakes
- Performance reporting

### 4.2 Agent Architecture Recommendation

```typescript
// Service boundary
Agent Orchestration Service
├── Agent Registry (profiles, traits, status)
├── Matchmaking Bridge (finds eligible tables)
├── Decision Engine (poker AI logic)
├── Runtime Controller (spawn/stop/monitor)
└── Reporting Module (stats, rewards)
```

**Implementation Options:**

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **Separate Node.js service** | Same stack, easy integration | Not optimal for AI | ✅ Start here |
| **Python microservice** | Better AI libraries | Multi-language complexity | Later if needed |
| **Rust service** | Ultra-fast, low latency | Steeper learning curve | Overkill for v1 |

**Suggested Stack:**
- Node.js/TypeScript agent service
- Simple rule-based AI (no ML for v1)
- Connect to game server via internal API
- Use Redis for agent queue management

### 4.3 Agent Decision Logic (v1 Simple Approach)

**Don't overthink it.** Agents just need to be:
1. **Beatable** (humans should win 52-55% of the time)
2. **Human-like** (vary timing, make occasional mistakes)
3. **Non-exploitable** (no obvious patterns)

**Simple Algorithm:**
```
Agent Type: Tight
- Fold 70% of hands preflop
- Bet/raise with strong hands only
- Check/call with medium hands
- Vary bet sizes: 50-75% pot

Agent Type: Aggressive  
- Raise 40% of hands preflop
- Bet/raise frequently
- Bluff 20% of the time
- Vary bet sizes: 75-150% pot

Agent Type: Calling Station
- Call frequently, fold rarely
- Only bet/raise with very strong hands
- Predictable but hard to bluff
```

**Add randomness:**
- Occasional "bad plays" (5-10% of the time)
- Timing variance (200-2000ms action delay)
- Bet size jitter (±10%)

**Advanced Later:**
- Opponent modeling
- Hand range analysis
- Game theory optimal (GTO) adjustments

### 4.4 Estimated Agent System Build Time

| Task | Effort | Dependencies |
|------|--------|--------------|
| Agent service scaffolding | 3 days | - |
| Redis integration | 2 days | - |
| Decision engine (simple AI) | 1 week | - |
| Matchmaking integration | 3 days | Matchmaking service |
| Agent profiles/traits | 2 days | - |
| Testing & tuning | 1 week | - |
| **Total** | **3-4 weeks** | Matchmaking service first |

---

## 5. Critical Missing Component: Instant Play UX

### 5.1 What "Instant Play" Means

**Current UX:**
1. User logs in
2. Goes to lobby
3. Sees list of games
4. Manually joins one
5. Waits for other players
6. Creator clicks "Start Game"
7. Finally plays

**Time to first hand:** 2-5 minutes (often longer if table empty)

**Desired UX:**
1. User clicks "Play Now"
2. **Instantly seated at active table**
3. Hand starts within 10 seconds

**Time to first hand:** <10 seconds

### 5.2 What This Requires

**Matchmaking Service:**
- Player queue management
- Stake level selection
- Balance verification
- Table assignment algorithm
- Human-first placement (fill tables with humans before agents)

**Auto-Table Management:**
- Pre-create tables at popular stakes
- Keep tables "warm" with agents
- Close empty tables after timeout
- Dynamic table scaling based on demand

**Backend Flow:**
```typescript
// User clicks "Play Now"
POST /api/play-now
{
  stakeLevel: "low", // 0.10/0.20 blinds
  buyInAmount: 10.00
}

// Matchmaking service
1. Check queue for existing table with open seat
2. If found → seat player immediately
3. If not found → create new table + fill with agents + seat player
4. Start hand when 2+ humans seated OR after 5-second delay

// Response
{
  tableId: "abc123",
  seatNumber: 3,
  startTime: "2026-04-20T13:15:00Z"
}

// Client auto-navigates to game
```

### 5.3 Estimated Instant Play Build Time

| Task | Effort | Dependencies |
|------|--------|--------------|
| Matchmaking service | 1 week | Agent system |
| Auto-table management | 3 days | - |
| Play Now UI | 2 days | - |
| Stake level config | 2 days | - |
| Testing & optimization | 3 days | - |
| **Total** | **2-3 weeks** | Agent system first |

---

## 6. Phased Implementation Plan (Revised)

### Our Current Position
- **April 13, 2026:** Core poker engine complete
- **Today (April 20):** Planning agent/matchmaking systems

### Proposed Timeline

#### **Sprint 1: Finish Variable Buy-Ins** (1 week)
**Goal:** Complete the 50% done feature from April 13th

- [ ] Buy-in selection UI (create game modal)
- [ ] Join game with custom buy-in API
- [ ] Creator buy-in selection before start
- [ ] Test with 3 players
- [ ] Fix any bugs from April 13th session

**Why First:** Need to test multi-player properly before building on top of it.

#### **Sprint 2: Agent System Foundation** (2 weeks)
**Goal:** Basic agents that can play poker

- [ ] Agent service scaffolding (Node.js)
- [ ] Redis integration for queue
- [ ] Simple decision engine (tight/aggressive/loose agents)
- [ ] Internal API to connect to game server
- [ ] Agent profile database schema
- [ ] Basic spawn/stop controls

**Deliverable:** Can manually spawn agents into existing games

#### **Sprint 3: Matchmaking Service** (2 weeks)
**Goal:** Auto-seat players and agents

- [ ] Matchmaking service scaffolding
- [ ] Player queue management
- [ ] Table assignment algorithm
- [ ] Auto-table creation/closure
- [ ] Stake level configuration
- [ ] Human-first placement logic

**Deliverable:** "Play Now" button works

#### **Sprint 4: Integration & Polish** (1 week)
**Goal:** End-to-end instant play flow

- [ ] Connect matchmaking → agent orchestration
- [ ] Fill new tables with agents automatically
- [ ] Optimize time-to-first-hand
- [ ] Add table transparency (show humans vs agents)
- [ ] Basic session feedback
- [ ] Load testing (simulate 100+ concurrent games)

**Deliverable:** Phase 1 MVP complete

**Total Time to Phase 1 MVP:** 6-7 weeks from today

#### **Sprint 5-7: Phase 2 Features** (3 weeks)
- Withdrawal status tracking
- Session results screens
- Anti-abuse monitoring
- Hand history viewer

#### **Sprint 8-11: Phase 3 Features** (4 weeks)
- Table creator revenue share
- Referral system
- Creator leaderboard
- Rake distribution logic

#### **Sprint 12+: Phase 4-6** (TBD based on traction)

---

## 7. Risk Assessment

### 7.1 Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Agent play quality** | High | Medium | Iterative tuning, human testing, A/B test agent types |
| **Matchmaking speed** | High | Low | Pre-warm tables, Redis queue, optimize algorithm |
| **Collusion detection** | High | Medium | Pattern analysis, table limits, manual review |
| **Scale (100+ tables)** | Medium | Medium | Redis caching, horizontal scaling, load testing |
| **RNG fairness perception** | High | Low | Audit logs, provable fairness option later |
| **Withdrawal delays** | High | Low | Automated settlement, clear status tracking |

### 7.2 Product Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Agents too good → humans quit** | Critical | Medium | Tune win rate to 45-48%, add randomness, monitor retention |
| **Agents too bad → no liquidity value** | High | Medium | Balance difficulty, test with real users, iterate |
| **Cold start (no users)** | Critical | High | Agent liquidity solves this, incentivize early users |
| **Rake/rewards gaming** | High | Medium | Anti-abuse rules, rate limits, manual review |
| **Regulatory risk** | Critical | Low-Med | Legal disclaimers, geo-blocking if needed, KYC later |

### 7.3 Economic Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Rake too high → players leave** | High | Medium | Competitive analysis, A/B test rates, adjust dynamically |
| **Revenue share too high → loss** | Medium | Low | Cap at reasonable %, require minimum table activity |
| **Referral abuse** | Medium | High | Cap earnings, require downstream activity, fraud detection |
| **Points/airdrop expectations** | High | Medium | Clear disclaimers, no guarantees, performance-based only |

---

## 8. Architecture Recommendations

### 8.1 Short-Term (Next 3 Months)

**Keep the monolith, but structure it properly:**

```
poker-game/
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── api/ (HTTP endpoints)
│   │   │   ├── services/
│   │   │   │   ├── auth/
│   │   │   │   ├── wallet/
│   │   │   │   ├── game/ (poker engine)
│   │   │   │   ├── matchmaking/ (NEW)
│   │   │   │   ├── agents/ (NEW)
│   │   │   │   ├── rewards/ (later)
│   │   │   │   └── admin/
│   │   │   ├── socket/ (WebSocket handlers)
│   │   │   └── utils/
│   ├── agents/ (NEW: separate service)
│   │   ├── src/
│   │   │   ├── decision-engine/
│   │   │   ├── profiles/
│   │   │   ├── runtime/
│   │   │   └── api/ (internal only)
│   ├── contracts/ (existing)
│   └── frontend/ (existing)
```

**Add Redis:**
- Session cache
- Game state cache (hot tables)
- Matchmaking queue
- Rate limiting
- Agent assignment queue

**Why:** Monolith is fine for MVP. Redis adds necessary performance without microservice complexity.

### 8.2 Medium-Term (6-12 Months)

**If we hit scale limits, extract services in this order:**

1. **Agent Orchestration** → Already separate, can scale independently
2. **Matchmaking Service** → Redis-backed, lightweight, easy to split
3. **Rewards/Referral Service** → Background jobs, doesn't need real-time
4. **Analytics Service** → Read-only, can use replica DB

**Don't split game engine.** It's stateful and performance-critical. Keep it in main backend.

### 8.3 Database Optimization

**Current schema is mostly good, but add:**

```sql
-- Stake levels (auto-table management)
CREATE TABLE stake_levels (
  id UUID PRIMARY KEY,
  name VARCHAR(50) NOT NULL, -- "Low", "Medium", "High"
  small_blind BIGINT NOT NULL,
  big_blind BIGINT NOT NULL,
  min_buy_in BIGINT NOT NULL,
  max_buy_in BIGINT NOT NULL,
  enabled BOOLEAN DEFAULT true
);

-- Matchmaking queue
CREATE TABLE matchmaking_queue (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  stake_level_id UUID NOT NULL,
  buy_in_amount BIGINT NOT NULL,
  status VARCHAR(20) DEFAULT 'waiting', -- waiting, matched, cancelled
  created_at TIMESTAMP DEFAULT NOW(),
  matched_at TIMESTAMP,
  table_id UUID,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (stake_level_id) REFERENCES stake_levels(id)
);
CREATE INDEX idx_queue_status ON matchmaking_queue(status, created_at);

-- Agent profiles
CREATE TABLE agents (
  id UUID PRIMARY KEY,
  owner_user_id UUID, -- NULL for platform agents
  name VARCHAR(100),
  visible_trait VARCHAR(50), -- "Tight", "Aggressive", etc.
  hidden_trait VARCHAR(50), -- Secret for unpredictability
  stake_level_id UUID,
  status VARCHAR(20) DEFAULT 'idle', -- idle, active, paused
  lifetime_hands INT DEFAULT 0,
  lifetime_profit BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (stake_level_id) REFERENCES stake_levels(id)
);

-- Agent sessions (tracks agent table participation)
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL,
  table_id UUID NOT NULL,
  seat_number INT NOT NULL,
  buy_in BIGINT NOT NULL,
  final_stack BIGINT,
  hands_played INT DEFAULT 0,
  profit BIGINT DEFAULT 0,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (table_id) REFERENCES games(id)
);

-- Table creator revenue (Phase 3)
CREATE TABLE creator_revenue (
  id UUID PRIMARY KEY,
  creator_user_id UUID NOT NULL,
  table_id UUID NOT NULL,
  hand_id UUID NOT NULL,
  rake_amount BIGINT NOT NULL,
  share_amount BIGINT NOT NULL, -- Creator's cut
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (creator_user_id) REFERENCES users(id),
  FOREIGN KEY (table_id) REFERENCES games(id),
  FOREIGN KEY (hand_id) REFERENCES hands(id)
);

-- Referral tracking (Phase 3)
CREATE TABLE referrals (
  id UUID PRIMARY KEY,
  referrer_user_id UUID NOT NULL,
  referred_user_id UUID NOT NULL,
  referral_code VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, active, rewarded
  total_earnings BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (referrer_user_id) REFERENCES users(id),
  FOREIGN KEY (referred_user_id) REFERENCES users(id)
);

-- Points system (Phase 5)
CREATE TABLE user_points (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  source_type VARCHAR(50) NOT NULL, -- playing, creating, referring, liquidity
  points INT NOT NULL,
  multiplier DECIMAL(3,2) DEFAULT 1.0,
  reference_id UUID, -- Hand/table/agent session ID
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_points_user ON user_points(user_id, created_at);
```

---

## 9. What NOT to Build (Per Roadmap)

The roadmap explicitly warns against:

❌ **Complex AI** - Keep agents simple and rule-based  
❌ **NFTs/Tokens** - Defer until product-market fit  
❌ **Advanced graphics** - Functional > flashy for v1  
❌ **Too many stakes** - Start with 2-3 levels  
❌ **Complex lobbies** - Instant play > browsing  

**I strongly agree.** These are distractions. Focus on liquidity flywheel first.

---

## 10. Success Metrics (Per Phase)

### Phase 1 Metrics
- **Time to first hand** < 10 seconds
- **Table fill rate** > 80% (tables start within 30s of creation)
- **Agent/human ratio** 50-70% agents, healthy activity
- **Withdrawal completion** < 1 hour from request
- **Crash rate** < 0.1% of hands

### Phase 2 Metrics
- **User retention** (D1, D7, D30)
- **Trust score** (surveys, withdrawal completion rate)
- **Transparency** (% users who check human/agent ratio)
- **Support tickets** < 5% of daily active users

### Phase 3 Metrics
- **Creator activation** (% of users who create tables)
- **Creator revenue** (average earnings per creator)
- **Referral conversion** (% of referred users who deposit)
- **Leaderboard engagement** (% who check rankings)

---

## 11. Competitive Landscape

### What Exists Today
- **PokerStars, 888poker, GGPoker:** Web2, slow withdrawals, no crypto
- **CoinPoker, Virtue Poker:** Crypto poker, but no agent liquidity
- **Other crypto poker sites:** Low activity, empty tables, no innovation

### Your Competitive Advantage
1. **Agent-powered liquidity** → No cold start problem
2. **Instant play** → 10 seconds to game vs 5+ minutes elsewhere
3. **Crypto-native** → Fast withdrawals, no fiat friction
4. **Multiple earning paths** → Not just winning hands
5. **Creator economy** → Players bring players

### What Could Kill You
1. **Agents too obvious** → Feels fake/rigged
2. **Slow/buggy UX** → Users expect web2 polish
3. **Regulatory issues** → Geo-blocks or shutdowns
4. **Competitor copies you** → First-mover advantage matters
5. **Economic collapse** → Rake/rewards unsustainable

---

## 12. My Honest Assessment

### What's Good About This Plan

✅ **Clear vision** - Agent liquidity is a real innovation  
✅ **Phased approach** - Build → test → scale  
✅ **Multiple revenue streams** - Not just rake  
✅ **Realistic tech stack** - No blockchain gaming nonsense  
✅ **Economic incentives** - Aligns users with platform growth  

### What Concerns Me

⚠️ **Agent quality is HARD** - Balancing fun vs fairness is tricky  
⚠️ **Cold start chicken-egg** - Need agents before users, but agents need tuning with real users  
⚠️ **Regulatory risk** - Crypto + gambling = legal gray area  
⚠️ **Economic complexity** - Rake sharing + referrals + points = many attack vectors  
⚠️ **Scale assumptions** - Redis/microservices before knowing if you need them  

### What I'd Change

🔧 **Start even simpler:**
- Phase 1 should be: working poker + basic agents + instant play. That's it.
- Defer table creator economy until you prove liquidity works
- Defer points/airdrop until you have retention problem
- Consider launching with 0% rake initially to grow faster

🔧 **Add feedback loops:**
- Weekly user interviews
- Agent performance dashboards for internal team
- A/B test everything (agent types, rake rates, UI flows)

🔧 **Risk management:**
- Legal review before launch (even if "beta")
- Start with low stakes only ($1-10 tables)
- Geographic restrictions (avoid US, China initially)
- Manual withdrawal approval for large amounts

---

## 13. Recommended Next Steps

### This Week (April 20-27)
1. ✅ Review these docs with team
2. ✅ Decide: monolith or microservices?
3. ✅ Decide: build agents now or hire AI specialist?
4. ✅ Set up Redis (staging environment)
5. ✅ Finish variable buy-ins from April 13th

### Next 2 Weeks (April 28 - May 11)
6. 🏗️ Build agent service (Node.js, separate package)
7. 🏗️ Implement simple decision engine (tight/aggressive/loose)
8. 🏗️ Test agents against each other (no humans yet)
9. 🏗️ Tune agent behavior until "feels human"

### Weeks 3-4 (May 12-25)
10. 🏗️ Build matchmaking service
11. 🏗️ Implement auto-table management
12. 🏗️ Add stake level configuration
13. 🏗️ Build "Play Now" UI

### Week 5 (May 26-31)
14. 🧪 Integration testing (end-to-end flows)
15. 🧪 Load testing (simulate 100 concurrent tables)
16. 🧪 Alpha test with friends/team
17. 🚀 **Internal beta launch**

### Week 6+ (June onwards)
18. 📊 Monitor metrics
19. 🐛 Fix bugs based on feedback
20. 🚀 Public beta launch
21. 🎯 Build Phase 2 features

---

## 14. Budget Estimate

### Development Costs (6-week sprint to Phase 1 MVP)

| Role | Rate | Hours | Cost |
|------|------|-------|------|
| Full-stack dev (me) | $100/hr | 240 hrs | $24,000 |
| AI/Agent specialist | $150/hr | 80 hrs | $12,000 |
| Designer (UI/UX) | $80/hr | 40 hrs | $3,200 |
| QA tester | $50/hr | 40 hrs | $2,000 |
| **Subtotal** | | **400 hrs** | **$41,200** |

### Infrastructure Costs (Monthly)

| Service | Cost |
|---------|------|
| AWS/GCP (servers) | $500 |
| PostgreSQL (managed) | $100 |
| Redis (managed) | $100 |
| Etherscan/Linea RPC | $50 |
| Monitoring (Sentry, etc.) | $100 |
| **Subtotal** | **$850/mo** |

### Phase 1 Total: ~$45,000 + $850/mo

### Phase 2-3 Total: ~$60,000 (est.)

### Phase 4-6 Total: TBD based on traction

---

## 15. Final Recommendation

### Do This
1. **Finish variable buy-ins this week**
2. **Start agent system next week**
3. **Launch Phase 1 MVP in 6 weeks**
4. **Defer everything else until Phase 1 proven**

### Don't Do This
1. ❌ Don't build microservices yet (premature optimization)
2. ❌ Don't build complex AI (simple rules are fine)
3. ❌ Don't build points/tokens yet (distraction)
4. ❌ Don't launch with high stakes (risk management)

### The Bet
If agent liquidity works, you've solved poker's biggest problem. If it doesn't, no amount of creator economy or points will save you.

**Focus ruthlessly on Phase 1 instant play + agents. Everything else is optional.**

---

**Ready to discuss? Let me know if you want me to dive deeper into any section.**
