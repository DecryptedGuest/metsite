-- IA events pay XP as well as quota points, so the row records what XP was
-- given. There is no outbox for XP — it is applied straight to the balance —
-- so this is its receipt, and it is what a withdrawal takes back.
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "xpEach" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "xpAward" JSONB;
