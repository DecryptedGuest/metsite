-- Leave of absence moves to Discord entirely: /loa request, active, admin,
-- history, manage, pending. The site had a page for it and nothing else read
-- the table, so the workflow moves rather than being duplicated.

-- Somebody who has never signed in to the dashboard can still ask for leave,
-- so the site account stops being required and the Discord id becomes the
-- identity every subcommand works from.
ALTER TABLE "loa_requests" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "discordId" TEXT;
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "discordUsername" TEXT;

-- The posted request card, so a decision edits it in place rather than leaving
-- a stale "pending" message behind.
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "messageId" TEXT;
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "channelId" TEXT;

-- Ended before the end date — by the member coming back, or by command.
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3);
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "endedById" TEXT;
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "endedByName" TEXT;

-- A pending extension / reduction the member has asked for.
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "changeRequest" JSONB;

-- Closed off automatically once the end date passed, so a sweep cannot close
-- the same leave twice.
ALTER TABLE "loa_requests" ADD COLUMN IF NOT EXISTS "expiredAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "loa_requests_discordId_idx" ON "loa_requests"("discordId");
CREATE INDEX IF NOT EXISTS "loa_requests_endAt_idx"     ON "loa_requests"("endAt");
