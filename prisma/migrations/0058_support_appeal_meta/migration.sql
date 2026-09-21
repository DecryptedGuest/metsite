-- Disciplinary Appeal tickets: store the structured punishment being appealed
-- so IA get an enriched (Roblox/Discord/case) card that the opener never sees.
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "appealMeta" JSONB;
