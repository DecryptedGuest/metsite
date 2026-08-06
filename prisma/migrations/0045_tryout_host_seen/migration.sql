-- Track when the host was last present in their tryout server, so an abandoned
-- tryout (host gone >20 min, not rejoined) can be auto-cancelled.
ALTER TABLE "tryouts" ADD COLUMN IF NOT EXISTS "hostLastSeenAt" TIMESTAMP(3);
