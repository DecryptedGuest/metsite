-- Immutable audit trail for the MET HICOMM oversight dashboard.
CREATE TABLE "audit_log" (
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
  "meta"       JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");
CREATE INDEX "audit_log_category_idx" ON "audit_log"("category");
CREATE INDEX "audit_log_actorId_idx" ON "audit_log"("actorId");
CREATE INDEX "audit_log_targetId_idx" ON "audit_log"("targetId");
