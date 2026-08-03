-- The Internal Affairs application: six sections, filled in over more than one
-- sitting, marked by a Deputy Director or above.
--
-- A draft and a submission are the SAME row, told apart by `status`. Two tables
-- would mean copying every answer across at submit time, and that copy is a
-- transaction that can half-fail and leave somebody's work in neither place.
--
-- Written idempotently (IF NOT EXISTS throughout) because this deployment syncs
-- its schema with `prisma db push` rather than by applying migrations in order,
-- so this file has to be safe to run against a database that already has some or
-- all of it.
CREATE TABLE IF NOT EXISTS "ia_applications" (
  "id"              TEXT NOT NULL,
  "appRef"          TEXT NOT NULL,
  "applicantId"     TEXT NOT NULL,
  -- Snapshotted, not joined. A marker reading an application from three weeks ago
  -- needs the name it was filed under, not the name the account has now.
  "discordId"       TEXT NOT NULL,
  "discordUsername" TEXT,
  "robloxId"        TEXT,
  "robloxUsername"  TEXT,
  "answers"         JSONB NOT NULL DEFAULT '{}',
  "captured"        JSONB,
  "context"         JSONB,
  -- DRAFT | SUBMITTED | ACCEPTED | REJECTED | WITHDRAWN
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "submittedAt"     TIMESTAMP(3),
  "telemetry"       JSONB,
  "flags"           JSONB,
  "scores"          JSONB,
  "score"           INTEGER,
  "maxScore"        INTEGER,
  "percentage"      INTEGER,
  "markerNote"      TEXT,
  "markedById"      TEXT,
  "markedByName"    TEXT,
  "markedAt"        TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ia_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ia_applications_appRef_key" ON "ia_applications"("appRef");
CREATE INDEX IF NOT EXISTS "ia_applications_status_idx"      ON "ia_applications"("status");
CREATE INDEX IF NOT EXISTS "ia_applications_applicantId_idx" ON "ia_applications"("applicantId");
CREATE INDEX IF NOT EXISTS "ia_applications_submittedAt_idx" ON "ia_applications"("submittedAt");

-- ONE draft per person, enforced by the database rather than by remembering to
-- check. A partial index, so it applies to drafts only: somebody may have any
-- number of past submissions and exactly one thing in progress. Without this, two
-- tabs open at once quietly become two half-finished applications, and whichever
-- one is submitted second is the one that looks abandoned.
CREATE UNIQUE INDEX IF NOT EXISTS "ia_applications_one_draft_per_user"
  ON "ia_applications"("applicantId") WHERE "status" = 'DRAFT';

DO $$ BEGIN
  ALTER TABLE "ia_applications" ADD CONSTRAINT "ia_applications_applicantId_fkey"
    FOREIGN KEY ("applicantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ia_applications" ADD CONSTRAINT "ia_applications_markedById_fkey"
    FOREIGN KEY ("markedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
