-- In-game log ingest, LOA requests, rank history, and the tryout scheduled-event id.

-- Tryout: native Discord Scheduled Event id (best-effort; deleted on cancel/complete).
ALTER TABLE "tryouts" ADD COLUMN IF NOT EXISTS "scheduledEventId" TEXT;

-- Adonis/join/leave/chat logs POSTed from the Roblox training game.
CREATE TABLE IF NOT EXISTS "game_logs" (
  "id"        TEXT NOT NULL,
  "source"    TEXT NOT NULL,
  "actor"     TEXT,
  "actorId"   TEXT,
  "target"    TEXT,
  "action"    TEXT,
  "message"   TEXT,
  "place"     TEXT,
  "raw"       JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "game_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "game_logs_source_idx" ON "game_logs"("source");
CREATE INDEX IF NOT EXISTS "game_logs_actorId_idx" ON "game_logs"("actorId");
CREATE INDEX IF NOT EXISTS "game_logs_createdAt_idx" ON "game_logs"("createdAt");

-- Leave-of-absence requests forwarded to divisional / MET HICOMM.
CREATE TABLE IF NOT EXISTS "loa_requests" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "userName"     TEXT,
  "scope"        TEXT NOT NULL DEFAULT 'DIVISION',
  "division"     TEXT,
  "reason"       TEXT,
  "startAt"      TIMESTAMP(3) NOT NULL,
  "endAt"        TIMESTAMP(3) NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "forwardedTo"  TEXT,
  "reviewerId"   TEXT,
  "reviewerName" TEXT,
  "reviewNote"   TEXT,
  "reviewedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "loa_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "loa_requests_userId_idx" ON "loa_requests"("userId");
CREATE INDEX IF NOT EXISTS "loa_requests_status_idx" ON "loa_requests"("status");
CREATE INDEX IF NOT EXISTS "loa_requests_division_idx" ON "loa_requests"("division");

-- Promotion/demotion history (ingested from Discord or written by site actions).
CREATE TABLE IF NOT EXISTS "rank_history" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT,
  "robloxId"   TEXT,
  "discordId"  TEXT,
  "memberName" TEXT,
  "group"      TEXT NOT NULL DEFAULT 'MET',
  "fromRank"   TEXT,
  "toRank"     TEXT,
  "reason"     TEXT,
  "byName"     TEXT,
  "source"     TEXT NOT NULL DEFAULT 'DISCORD',
  "messageId"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rank_history_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "rank_history_messageId_key" ON "rank_history"("messageId");
CREATE INDEX IF NOT EXISTS "rank_history_userId_idx" ON "rank_history"("userId");
CREATE INDEX IF NOT EXISTS "rank_history_robloxId_idx" ON "rank_history"("robloxId");
CREATE INDEX IF NOT EXISTS "rank_history_discordId_idx" ON "rank_history"("discordId");
CREATE INDEX IF NOT EXISTS "rank_history_createdAt_idx" ON "rank_history"("createdAt");
