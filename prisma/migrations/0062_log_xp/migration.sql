-- Approving a patrol/event log now awards XP as well as database points. The
-- flag is separate from `pointAwarded` because the two awards have different
-- conditions (the XP award needs an FLP officer who isn't the host) and either
-- can land without the other.
ALTER TABLE "patrol_logs" ADD COLUMN IF NOT EXISTS "xpAwarded" BOOLEAN NOT NULL DEFAULT false;
-- What was actually given, to whom. Read by the site and by the audit trail;
-- also what makes a re-run idempotent rather than merely flagged.
ALTER TABLE "patrol_logs" ADD COLUMN IF NOT EXISTS "xpAward" JSONB;
