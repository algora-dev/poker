-- CreateTable
CREATE TABLE "AppLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "userId" TEXT,
    "gameId" TEXT,
    "handId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppLog_level_idx" ON "AppLog"("level");
CREATE INDEX "AppLog_category_idx" ON "AppLog"("category");
CREATE INDEX "AppLog_gameId_idx" ON "AppLog"("gameId");
CREATE INDEX "AppLog_createdAt_idx" ON "AppLog"("createdAt");
