-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "currentHandId" TEXT,
ADD COLUMN     "dealerIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GamePlayer" ADD COLUMN     "holeCards" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "Hand" ADD COLUMN     "activePlayerIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentBet" BIGINT NOT NULL DEFAULT 0;
