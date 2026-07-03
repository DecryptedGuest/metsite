-- Migration: multi-action punishments with role expiry
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "actions" JSONB;

CREATE TABLE IF NOT EXISTS "case_punishments" (
  "id"           TEXT NOT NULL,
  "caseId"       TEXT NOT NULL,
  "action"       TEXT NOT NULL,
  "roleId"       TEXT,
  "durationDays" INTEGER,
  "expiresAt"    TIMESTAMP(3),
  "roleRemoved"  BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "case_punishments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "case_punishments_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "cases"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
