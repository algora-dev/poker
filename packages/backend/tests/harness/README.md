# T3 Poker — Bot-driven playtest harness

A small framework that drives the **real running backend** (HTTP + Socket.io)
with N concurrent fake clients, used for the manual playtest gate Gerald
flagged in `audits/t3-poker/10-re-audit-followup-branch.md`.

This is NOT the in-process simulator (`tests/sim/...`). The simulator drives
pure poker logic for fast regression. This harness exercises:

- Auth + JWT + rate limits
- Game create / join / start API
- Socket.io join + private rooms
- Real `processAction` flow under concurrency
- Disconnect / reconnect mid-hand
- Action-timeout auto-fold path
- Mid-game cashout (player elimination on chips=0)
- Chip ledger + accounting under load

## How to run

Prereqs:
- Backend reachable at `HARNESS_BASE_URL` (default `http://localhost:3000`)
- Backend's admin secret in `HARNESS_ADMIN_SECRET` (used to top up bot bankrolls)
- For local runs: docker-compose Postgres up and `npm run dev` in backend

```bash
# Local fast loop
docker-compose up -d postgres
npm run --workspace=packages/backend migrate:dev   # one time
npm run dev:backend                                # in another shell
HARNESS_BASE_URL=http://localhost:3000 \
HARNESS_ADMIN_SECRET=<secret> \
npm run --workspace=packages/backend harness

# Single scenario
HARNESS_SCENARIO=eight_player_full_session npm run --workspace=packages/backend harness

# Against deployed dev backend
HARNESS_BASE_URL=https://poker-gamebackend-production.up.railway.app \
HARNESS_ADMIN_SECRET=<secret> \
npm run --workspace=packages/backend harness
```

## Scenarios

Defined in `scenarios.ts`. Each is a self-contained playtest:

- `eight_player_full_session` — 8 bots, 30 hands, mixed strategies
- `all_in_storm` — 4 bots forced into all-ins for showdown coverage
- `disconnect_reconnect` — 4 bots, one drops + reconnects mid-hand
- `action_timeout` — 3 bots, one stays silent to trigger auto-fold
- `cashout_mid_game` — 4 bots, one cashes out / busts before others
- `concurrency_blast` — 6 bots, multiple games in parallel

## Bot fill mode (live, dev-only)

Different from the harness: a small admin surface that lets a human play
from the frontend with bots filling the remaining seats. Implemented at
`src/services/botFill/` (the harness and bot-fill share `BotGameState` /
`Decision` types so neither implementation drifts).

Gated behind the **same** `ADMIN_SECRET` the rest of `/api/admin` uses.
In `NODE_ENV=production` the entire feature is **blocked** unless
`ALLOW_BOT_FILL=1` is also set — by design, this is meant for dev / Railway
dev / preview, not the live game.

Endpoints (all under `/api/admin`):

| Method | Path           | Body                                                                 |
|--------|----------------|----------------------------------------------------------------------|
| POST   | `/spawn-bots`  | `{ secret, gameId, count, strategy?, buyInChips?, bankrollChips?, thinkMs? }` |
| POST   | `/kill-bots`   | `{ secret, gameId }`                                                 |
| GET    | `/bots?secret=…` | (no body)                                                          |

Limits:
- `count` ≤ 9 per call (also clamped to free seats; response includes `clamped: true` when truncated).
- Max 2 concurrent spawn batches across the process.
- Strategies: `random` (default), `tight`, `loose`. Sizing rules in `src/services/botFill/strategies.ts`.

Lifecycle:
- Each bot gets a real `User` row (`bot_<uuid>@bots.local`), is bankroll-topped
  via the existing `/api/admin/add-chips` audited path, joins via
  `POST /games/:id/join` (so the active-game money lock + per-user mutex
  apply), and reacts to `your_turn` events through the same Socket.io pipeline
  as a real client.
- Bots auto-shutdown when the game completes/cancels.
- `SIGTERM` and `SIGINT` flush every active bot via `killAllBots()` before
  the Fastify server closes.

Logs are tagged `[BOT_FILL]` for easy filtering.

### PowerShell snippet (dev/local)

```powershell
$secret = '<your ADMIN_SECRET>'
$base   = 'http://localhost:3000'
$gameId = '<gameId-shaun-just-created>'

# Spawn 3 random-strategy bots into the game
Invoke-RestMethod -Method POST -Uri "$base/api/admin/spawn-bots" -ContentType 'application/json' -Body (@{
  secret   = $secret
  gameId   = $gameId
  count    = 3
  strategy = 'random'
} | ConvertTo-Json)

# List active bot sessions
Invoke-RestMethod -Method GET -Uri "$base/api/admin/bots?secret=$secret"

# Kill them when done
Invoke-RestMethod -Method POST -Uri "$base/api/admin/kill-bots" -ContentType 'application/json' -Body (@{
  secret = $secret
  gameId = $gameId
} | ConvertTo-Json)
```

### curl snippet (Railway dev)

```bash
SECRET=<admin-secret>
BASE=https://poker-gamebackend-production.up.railway.app
GAME=<gameId>

curl -sS -X POST "$BASE/api/admin/spawn-bots" \
  -H 'content-type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"gameId\":\"$GAME\",\"count\":3,\"strategy\":\"random\"}"
```

For Railway dev specifically: set `ALLOW_BOT_FILL=1` in the service env and
redeploy. The endpoint refuses to spawn anything in production without it.

## Invariants checked

After every hand and at session end:

- Sum of chip stacks + pot == initial chip bankroll
- No negative chip stacks
- No duplicate hand sequence numbers per scope
- No stuck `isMyTurn` for > 60s
- No socket disconnect/error on healthy bots
- All non-eliminated players have valid positions
- All known errors from server logs are zero

Failures throw and the harness exits non-zero.
