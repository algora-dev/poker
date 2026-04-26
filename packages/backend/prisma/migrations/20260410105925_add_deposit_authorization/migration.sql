-- CreateTable
CREATE TABLE "deposit_authorizations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposit_authorizations_walletAddress_key" ON "deposit_authorizations"("walletAddress");

-- CreateIndex
CREATE INDEX "deposit_authorizations_userId_idx" ON "deposit_authorizations"("userId");

-- CreateIndex
CREATE INDEX "deposit_authorizations_walletAddress_idx" ON "deposit_authorizations"("walletAddress");

-- CreateIndex
CREATE INDEX "deposit_authorizations_expiresAt_idx" ON "deposit_authorizations"("expiresAt");
