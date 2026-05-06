-- Phase 9 follow-up (audits/t3-poker/09-dave-followup-prompt.md):
--   item 2: server-issued deposit challenges (PendingDepositChallenge)
--   item 3: separate MoneyEvent ledger for off-table flows
--   item 4: HandEvent scopeId for safe per-scope sequence uniqueness

-- ---------------------------------------------------------------------------
-- 1. PendingDepositChallenge: server-side row created the moment the server
--    issues a deposit challenge. The signed-submit step REQUIRES this row to
--    exist; clients can no longer forge canonical challenges.
-- ---------------------------------------------------------------------------
CREATE TABLE "PendingDepositChallenge" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "walletAddress"   TEXT NOT NULL,
    "nonce"           TEXT NOT NULL,
    "chainId"         INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "amount"          BIGINT,
    "issuedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "used"            BOOLEAN NOT NULL DEFAULT false,
    "usedAt"          TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingDepositChallenge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingDepositChallenge_nonce_key" ON "PendingDepositChallenge"("nonce");
CREATE INDEX "PendingDepositChallenge_userId_idx" ON "PendingDepositChallenge"("userId");
CREATE INDEX "PendingDepositChallenge_walletAddress_idx" ON "PendingDepositChallenge"("walletAddress");
CREATE INDEX "PendingDepositChallenge_used_expiresAt_idx" ON "PendingDepositChallenge"("used", "expiresAt");

-- ---------------------------------------------------------------------------
-- 2. MoneyEvent: off-table money ledger. No FK to Game. Optional gameId/
--    handId/txHash/withdrawalId references for traceability. Replaces the
--    broken pseudo-id HandEvent writes for deposits.
-- ---------------------------------------------------------------------------
CREATE TABLE "MoneyEvent" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "eventType"      TEXT NOT NULL,
    "amount"         BIGINT NOT NULL,
    "balanceBefore"  BIGINT,
    "balanceAfter"   BIGINT,
    "gameId"         TEXT,
    "handId"         TEXT,
    "txHash"         TEXT,
    "withdrawalId"   TEXT,
    "depositId"      TEXT,
    "authorizationId" TEXT,
    "payload"        TEXT NOT NULL DEFAULT '{}',
    "correlationId"  TEXT,
    "serverTime"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MoneyEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MoneyEvent_userId_idx" ON "MoneyEvent"("userId");
CREATE INDEX "MoneyEvent_eventType_idx" ON "MoneyEvent"("eventType");
CREATE INDEX "MoneyEvent_txHash_idx" ON "MoneyEvent"("txHash");
CREATE INDEX "MoneyEvent_withdrawalId_idx" ON "MoneyEvent"("withdrawalId");
CREATE INDEX "MoneyEvent_correlationId_idx" ON "MoneyEvent"("correlationId");
CREATE INDEX "MoneyEvent_gameId_idx" ON "MoneyEvent"("gameId");
CREATE INDEX "MoneyEvent_serverTime_idx" ON "MoneyEvent"("serverTime");

-- ---------------------------------------------------------------------------
-- 3. HandEvent.scopeId for safe per-scope sequence uniqueness.
--    Postgres treats NULLs as distinct in unique indexes, which means the
--    old UNIQUE(gameId, handId, sequenceNumber) did NOT prevent duplicate
--    sequence numbers for game-level (handId IS NULL) events.
--    We add a non-null scopeId of the form 'hand:<id>' or 'game:<id>',
--    drop the old unique, and add UNIQUE(scopeId, sequenceNumber).
-- ---------------------------------------------------------------------------
ALTER TABLE "HandEvent" ADD COLUMN "scopeId" TEXT;

-- Backfill scopeId for any existing rows. Hand-scoped if handId is set,
-- otherwise game-scoped.
UPDATE "HandEvent"
   SET "scopeId" = CASE
       WHEN "handId" IS NOT NULL THEN 'hand:' || "handId"
       ELSE 'game:' || "gameId"
     END
 WHERE "scopeId" IS NULL;

ALTER TABLE "HandEvent" ALTER COLUMN "scopeId" SET NOT NULL;

-- Drop the old unique that didn't actually protect NULL handId buckets.
DROP INDEX IF EXISTS "HandEvent_gameId_handId_sequenceNumber_key";

CREATE UNIQUE INDEX "HandEvent_scopeId_sequenceNumber_key"
  ON "HandEvent"("scopeId", "sequenceNumber");

CREATE INDEX "HandEvent_scopeId_idx" ON "HandEvent"("scopeId");
