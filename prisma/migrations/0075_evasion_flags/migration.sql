-- Ban / punishment evasion flags.
CREATE TABLE IF NOT EXISTS "evasion_flags" (
  "id"              TEXT PRIMARY KEY,
  "robloxId"        TEXT NOT NULL,
  "robloxUsername"  TEXT,
  "discordId"       TEXT NOT NULL,
  "discordTag"      TEXT,
  "kind"            TEXT NOT NULL,
  "knownDiscordIds" JSONB,
  "evidence"        JSONB,
  "summary"         TEXT,
  "channelId"       TEXT,
  "messageId"       TEXT,
  "status"          TEXT NOT NULL DEFAULT 'OPEN',
  "actionTaken"     TEXT,
  "actionedById"    TEXT,
  "actionedByName"  TEXT,
  "actionedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "evasion_flags_robloxId_discordId_key" ON "evasion_flags"("robloxId", "discordId");
CREATE INDEX IF NOT EXISTS "evasion_flags_robloxId_idx" ON "evasion_flags"("robloxId");
CREATE INDEX IF NOT EXISTS "evasion_flags_discordId_idx" ON "evasion_flags"("discordId");
CREATE INDEX IF NOT EXISTS "evasion_flags_status_idx" ON "evasion_flags"("status");
