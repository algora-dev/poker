/*
  Warnings:

  - A unique constraint covering the columns `[handId,potNumber]` on the table `SidePot` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "SidePot_handId_potNumber_key" ON "SidePot"("handId", "potNumber");
