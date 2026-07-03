-- CreateTable: screenshot / capture security log
CREATE TABLE "capture_logs" (
  "id"              TEXT NOT NULL,
  "method"          TEXT NOT NULL,
  "details"         TEXT,
  "page"            TEXT,
  "os"              TEXT,
  "browser"         TEXT,
  "device"          TEXT,
  "userAgent"       TEXT,
  "screenInfo"      TEXT,
  "language"        TEXT,
  "ip"              TEXT,
  "userId"          TEXT,
  "discordId"       TEXT,
  "discordUsername" TEXT,
  "robloxId"        TEXT,
  "robloxUsername"  TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "capture_logs_createdAt_idx" ON "capture_logs"("createdAt");
