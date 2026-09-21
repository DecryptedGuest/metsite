-- EVENT logs: parsed + Discord-resolved structured fields (host, co-host,
-- attendees, notes, note members). Rendered as the pretty event card on-site.
ALTER TABLE "patrol_logs" ADD COLUMN IF NOT EXISTS "eventMeta" JSONB;
