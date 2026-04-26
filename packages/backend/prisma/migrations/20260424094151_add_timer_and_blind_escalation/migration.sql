-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "blindLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "handsAtLevel" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Hand" ADD COLUMN     "turnStartedAt" TIMESTAMP(3);
