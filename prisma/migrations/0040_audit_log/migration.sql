-- Immutable audit trail for the MET HICOMM oversight dashboard.
--
-- NOTE: "audit_log" is already created by 0026_sessions_audit, with a smaller
-- column set. This migration used to CREATE TABLE it again unconditionally,
-- so a migration run against a FRESH database failed right here with
-- 'relation "audit_log" already exists'. It now creates the table only if it is
-- missing and adds the extra columns individually, which is correct whether it
-- runs after 0026 (the normal case) or on its own.
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id"         TEXT NOT NULL,
  "category"   TEXT NOT NULL,
  "action"     TEXT NOT NULL,
  "actorId"    TEXT,
  "actorName"  TEXT,
  "actorRole"  TEXT,
  "targetType" TEXT,
  "targetId"   TEXT,
  "targetName" TEXT,
  "division"   TEXT,
  "summary"    TEXT,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- The columns 0026's version of the table doesn't have.
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "actorRole"  TEXT;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "targetName" TEXT;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "division"   TEXT;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "metadata"   JSONB;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "ip"         TEXT;

CREATE INDEX IF NOT EXISTS "audit_log_createdAt_idx" ON "audit_log"("createdAt");
CREATE INDEX IF NOT EXISTS "audit_log_category_idx"  ON "audit_log"("category");
CREATE INDEX IF NOT EXISTS "audit_log_actorId_idx"   ON "audit_log"("actorId");
CREATE INDEX IF NOT EXISTS "audit_log_targetId_idx"  ON "audit_log"("targetId");
