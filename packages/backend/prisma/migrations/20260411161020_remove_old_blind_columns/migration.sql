/*
  Warnings:

  - You are about to drop the column `blindBig` on the `Game` table. All the data in the column will be lost.
  - You are about to drop the column `blindSmall` on the `Game` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Game" DROP COLUMN "blindBig",
DROP COLUMN "blindSmall";
