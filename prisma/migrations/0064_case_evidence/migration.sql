-- Exhibits pulled off the case file when the link is imported.
--
-- The evidence on a case lives inside the linked document, which means reading
-- it costs a fetch of somebody else's Google Doc every time a panel opens —
-- slow, rate-limited, and broken the moment the doc's sharing changes. The
-- import already reads that document once, so the exhibits are captured then
-- and stored here as [{ label, url, note }].
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "evidence" JSONB;
