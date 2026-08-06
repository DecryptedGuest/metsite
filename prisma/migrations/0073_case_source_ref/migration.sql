-- The reference a case arrived with, when it was renamed (a coded Infraction ID,
-- or a renumbering that put refs back into chronological order).
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
