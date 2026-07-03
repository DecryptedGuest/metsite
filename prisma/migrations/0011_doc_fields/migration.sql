-- Add investigator Roblox fields and suspect display name to cases
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "investigatorRobloxId"       TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "investigatorRobloxUsername"  TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "investigatorDiscordUsername" TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "suspectRobloxDisplayName"   TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "punishmentsSummary"         TEXT;
