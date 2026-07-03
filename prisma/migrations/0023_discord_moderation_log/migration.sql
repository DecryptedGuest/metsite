-- CreateTable
CREATE TABLE "discord_moderation_log" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetDiscordId" TEXT NOT NULL,
    "targetUsername" TEXT,
    "reason" TEXT,
    "durationMinutes" INTEGER,
    "performedById" TEXT NOT NULL,
    "performedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_moderation_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discord_moderation_log_targetDiscordId_idx" ON "discord_moderation_log"("targetDiscordId");

-- CreateIndex
CREATE INDEX "discord_moderation_log_createdAt_idx" ON "discord_moderation_log"("createdAt");
