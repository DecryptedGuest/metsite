-- AlterTable: add IP + linked Roblox identity to users
ALTER TABLE "users" ADD COLUMN "lastIp" TEXT;
ALTER TABLE "users" ADD COLUMN "robloxId" TEXT;
ALTER TABLE "users" ADD COLUMN "robloxUsername" TEXT;

-- CreateTable: website visit log
CREATE TABLE "visits" (
  "id"              TEXT NOT NULL,
  "path"            TEXT NOT NULL,
  "ip"              TEXT,
  "userAgent"       TEXT,
  "userId"          TEXT,
  "discordId"       TEXT,
  "discordUsername" TEXT,
  "robloxId"        TEXT,
  "robloxUsername"  TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "visits_createdAt_idx" ON "visits"("createdAt");
