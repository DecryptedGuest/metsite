-- Passwordless "try another way" sign-in challenges (Discord DM code + QR approval).
CREATE TABLE IF NOT EXISTS "login_challenges" (
  "id"        TEXT NOT NULL,
  "method"    TEXT NOT NULL,
  "code"      TEXT,
  "discordId" TEXT,
  "userId"    TEXT,
  "status"    TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"  INTEGER NOT NULL DEFAULT 0,
  "ip"        TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "login_challenges_status_idx" ON "login_challenges"("status");
CREATE INDEX IF NOT EXISTS "login_challenges_expiresAt_idx" ON "login_challenges"("expiresAt");
