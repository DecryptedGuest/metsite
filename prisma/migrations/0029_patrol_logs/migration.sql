-- CreateTable
CREATE TABLE "patrol_logs" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "submitterDiscordId" TEXT NOT NULL,
    "submitterUsername" TEXT,
    "submitterDisplayName" TEXT,
    "division" TEXT,
    "shiftStart" TEXT,
    "shiftEnd" TEXT,
    "totalMinutes" INTEGER,
    "images" JSONB,
    "rawContent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patrol_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patrol_logs_messageId_key" ON "patrol_logs"("messageId");
CREATE INDEX "patrol_logs_status_idx" ON "patrol_logs"("status");
CREATE INDEX "patrol_logs_createdAt_idx" ON "patrol_logs"("createdAt");
