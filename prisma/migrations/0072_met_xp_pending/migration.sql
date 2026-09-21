-- XP imported for a Roblox account that has no Discord id yet.
CREATE TABLE IF NOT EXISTS "met_xp_pending" (
  "id"             SERIAL       PRIMARY KEY,
  "usernameKey"    TEXT         NOT NULL,
  "robloxUsername" TEXT         NOT NULL,
  "robloxId"       TEXT,
  "xp"             INTEGER      NOT NULL DEFAULT 0,
  "source"         TEXT         NOT NULL DEFAULT 'clanslabs',
  "claimedAt"      TIMESTAMP(3),
  "claimedBy"      TEXT,
  "claimedXp"      INTEGER,
  "note"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "met_xp_pending_usernameKey_key" ON "met_xp_pending"("usernameKey");
CREATE INDEX IF NOT EXISTS "met_xp_pending_robloxId_idx" ON "met_xp_pending"("robloxId");
CREATE INDEX IF NOT EXISTS "met_xp_pending_claimedAt_idx" ON "met_xp_pending"("claimedAt");
