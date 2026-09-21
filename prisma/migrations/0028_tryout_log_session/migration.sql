-- Idempotency key: one tryout log per in-game session, so a retried conclude
-- POST returns the existing log instead of creating a duplicate.
ALTER TABLE "tryout_logs" ADD COLUMN "gameSessionId" TEXT;
CREATE UNIQUE INDEX "tryout_logs_gameSessionId_key" ON "tryout_logs"("gameSessionId");
