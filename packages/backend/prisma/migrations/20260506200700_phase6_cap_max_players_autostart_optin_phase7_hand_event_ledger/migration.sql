-- Phase 6 [M-03]: cap Game.maxPlayers default at 8. Existing rows preserve
-- their stored value; only the default for new games changes.
ALTER TABLE "Game" ALTER COLUMN "maxPlayers" SET DEFAULT 8;

-- Phase 6 [M-04]: opt-in auto-start. Default false so a host must explicitly
-- enable auto-start when creating a game.
ALTER TABLE "Game" ADD COLUMN "autoStart" BOOLEAN NOT NULL DEFAULT false;

-- Phase 7 [M-05]: append-only hand/game event ledger. Sufficient to
-- reconstruct any hand internally and explain why chips moved.
CREATE TABLE "HandEvent" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "handId" TEXT,
    "userId" TEXT,
    "sequenceNumber" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "correlationId" TEXT,
    "serverTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HandEvent_gameId_idx" ON "HandEvent"("gameId");
CREATE INDEX "HandEvent_handId_idx" ON "HandEvent"("handId");
CREATE INDEX "HandEvent_eventType_idx" ON "HandEvent"("eventType");
CREATE INDEX "HandEvent_correlationId_idx" ON "HandEvent"("correlationId");

-- Per-(gameId, handId) monotonic sequence. Postgres treats NULL handId values
-- as distinct, so game-level events (handId IS NULL) can coexist freely.
CREATE UNIQUE INDEX "HandEvent_gameId_handId_sequenceNumber_key"
  ON "HandEvent"("gameId", "handId", "sequenceNumber");

-- FK to Game (cascade on delete to match the rest of the schema).
ALTER TABLE "HandEvent" ADD CONSTRAINT "HandEvent_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "Game"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
