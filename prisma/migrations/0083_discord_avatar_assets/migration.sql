CREATE TABLE IF NOT EXISTS "discord_avatar_assets" (
  "id" TEXT NOT NULL,
  "discordId" TEXT NOT NULL,
  "avatarHash" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'user',
  "url" TEXT,
  "assetId" TEXT,
  "operationId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "moderation" TEXT,
  "bytes" INTEGER,
  "error" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discord_avatar_assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "discord_avatar_assets_discordId_avatarHash_key"
  ON "discord_avatar_assets"("discordId", "avatarHash");
CREATE INDEX IF NOT EXISTS "discord_avatar_assets_state_idx" ON "discord_avatar_assets"("state");
