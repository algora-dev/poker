-- CreateTable
CREATE TABLE "SidePot" (
    "id" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "potNumber" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "cappedAt" BIGINT NOT NULL,
    "eligiblePlayerIds" TEXT NOT NULL,
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SidePot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SidePot_handId_idx" ON "SidePot"("handId");

-- AddForeignKey
ALTER TABLE "SidePot" ADD CONSTRAINT "SidePot_handId_fkey" FOREIGN KEY ("handId") REFERENCES "Hand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
