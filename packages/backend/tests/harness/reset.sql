-- Wipe game state so the harness starts fresh. Keep users + chip balances.
-- Resets ChipBalance to 0 too so the harness top-up is deterministic.
TRUNCATE "HandAction" CASCADE;
TRUNCATE "HandEvent" CASCADE;
TRUNCATE "MoneyEvent" CASCADE;
TRUNCATE "SidePot" CASCADE;
TRUNCATE "Hand" CASCADE;
TRUNCATE "GamePlayer" CASCADE;
TRUNCATE "Game" CASCADE;
TRUNCATE "ChipAudit" CASCADE;
UPDATE "ChipBalance" SET chips = 0;
TRUNCATE "AppLog" CASCADE;
