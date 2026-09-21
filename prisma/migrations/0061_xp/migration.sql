-- XP: a per-officer balance plus the audit trail behind it.
--
-- Idempotent (IF NOT EXISTS everywhere) so it re-runs cleanly against a
-- database that was already brought up with `prisma db push`, matching the
-- house style of 0059/0060.

CREATE TABLE IF NOT EXISTS "met_xp" (
  "discordId"      TEXT NOT NULL,
  "xp"             INTEGER NOT NULL DEFAULT 0,
  "robloxId"       TEXT,
  "robloxUsername" TEXT,
  "promotedRank"   TEXT,
  "promotedAt"     TIMESTAMP(3),
  "firstEarnedAt"  TIMESTAMP(3),
  -- No default: Prisma's @updatedAt always supplies it, and adding one here
  -- would show as drift against the schema.
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "met_xp_pkey" PRIMARY KEY ("discordId")
);
CREATE INDEX IF NOT EXISTS "met_xp_xp_idx" ON "met_xp"("xp");

CREATE TABLE IF NOT EXISTS "xp_events" (
  "id"         TEXT NOT NULL,
  "discordId"  TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "delta"      INTEGER NOT NULL DEFAULT 0,
  "before"     INTEGER NOT NULL DEFAULT 0,
  "after"      INTEGER NOT NULL DEFAULT 0,
  "reason"     TEXT,
  "fromRank"   TEXT,
  "toRank"     TEXT,
  "issuedById" TEXT,
  "issuedBy"   TEXT,
  "messageId"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "xp_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "xp_events_discordId_idx" ON "xp_events"("discordId");
CREATE INDEX IF NOT EXISTS "xp_events_createdAt_idx" ON "xp_events"("createdAt");
