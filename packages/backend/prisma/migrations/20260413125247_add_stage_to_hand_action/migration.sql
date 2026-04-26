/*
  Warnings:

  - Added the required column `stage` to the `HandAction` table without a default value. This is not possible if the table is not empty.

*/

-- Step 1: Add column with default value first
ALTER TABLE "HandAction" ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'preflop';

-- Step 2: Backfill existing data (all old actions are from test games, set to preflop)
UPDATE "HandAction" SET "stage" = 'preflop' WHERE "stage" IS NULL OR "stage" = 'preflop';

-- Step 3: Remove default (new actions must specify stage explicitly)
ALTER TABLE "HandAction" ALTER COLUMN "stage" DROP DEFAULT;

-- Step 4: Create index for fast stage queries
CREATE INDEX "HandAction_handId_stage_idx" ON "HandAction"("handId", "stage");
