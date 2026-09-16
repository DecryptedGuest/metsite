ALTER TABLE "discord_avatar_assets" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
CREATE INDEX IF NOT EXISTS "discord_avatar_assets_contentHash_idx" ON "discord_avatar_assets"("contentHash");
CREATE INDEX IF NOT EXISTS "discord_avatar_assets_discordId_state_idx" ON "discord_avatar_assets"("discordId", "state");
