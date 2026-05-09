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
