-- 0029_activity_logs
-- Patrol & event logs mirrored from Discord.
--
-- Officers log patrols and events in Discord; a supervisor signs one off by
-- reacting with a tick (approve) or a cross (deny). The site reads that
-- decision off the message's own reactions, so a log ticked or crossed by
-- ANYBODY registers as approved/denied here — it never depends on the decision
-- having been taken through the site.
--
-- Idempotent: safe to re-run.

-- ── Enums ────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "ActivityLogKind" AS ENUM ('PATROL', 'EVENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ActivityLogStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "activity_logs" (
    "id"                    TEXT NOT NULL,
    "messageId"             TEXT NOT NULL,
    "channelId"             TEXT NOT NULL,
    "guildId"               TEXT,
    "kind"                  "ActivityLogKind" NOT NULL,
    "status"                "ActivityLogStatus" NOT NULL DEFAULT 'PENDING',
    "officerId"             TEXT,
    "officerDiscordId"      TEXT,
    "officerUsername"       TEXT,
    "officerRobloxUsername" TEXT,
    "content"               TEXT,
    "attachments"           JSONB,
    "loggedAt"              TIMESTAMP(3) NOT NULL,
    "decidedAt"             TIMESTAMP(3),
    "decidedByDiscordId"    TEXT,
    "decidedByName"         TEXT,
    "decidedByUserId"       TEXT,
    "decisionSource"        TEXT,
    "tickCount"             INTEGER NOT NULL DEFAULT 0,
    "crossCount"            INTEGER NOT NULL DEFAULT 0,
    "raw"                   JSONB,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DEFAULT: Prisma's @updatedAt always writes this, and the convention in
    -- every migration since 0021 is to leave it out so `migrate diff` stays clean.
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "activity_logs_messageId_key"       ON "activity_logs"("messageId");
CREATE INDEX        IF NOT EXISTS "activity_logs_loggedAt_idx"        ON "activity_logs"("loggedAt");
CREATE INDEX        IF NOT EXISTS "activity_logs_officerId_idx"       ON "activity_logs"("officerId");
CREATE INDEX        IF NOT EXISTS "activity_logs_officerDiscordId_idx" ON "activity_logs"("officerDiscordId");
CREATE INDEX        IF NOT EXISTS "activity_logs_status_idx"          ON "activity_logs"("status");
CREATE INDEX        IF NOT EXISTS "activity_logs_kind_idx"            ON "activity_logs"("kind");

-- officerId is a soft link: a log stays on the site even if the officer's site
-- account is removed, so the FK is ON DELETE SET NULL rather than CASCADE.
DO $$ BEGIN
    ALTER TABLE "activity_logs"
        ADD CONSTRAINT "activity_logs_officerId_fkey"
        FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
