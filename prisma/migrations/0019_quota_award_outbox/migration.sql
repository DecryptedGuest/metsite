CREATE TABLE IF NOT EXISTS "quota_awards" (
    "id"             TEXT NOT NULL,
    "refType"        TEXT NOT NULL,
    "refId"          TEXT NOT NULL,
    "discordId"      TEXT,
    "robloxUsername" TEXT,
    "points"         INTEGER NOT NULL,
    "label"          TEXT,
    "status"         TEXT NOT NULL DEFAULT 'PENDING',
    "attempts"       INTEGER NOT NULL DEFAULT 0,
    "lastError"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quota_awards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "quota_awards_refType_refId_key" ON "quota_awards"("refType", "refId");
CREATE INDEX IF NOT EXISTS "quota_awards_status_idx" ON "quota_awards"("status");
