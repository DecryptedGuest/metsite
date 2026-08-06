-- 0028_ia_overhaul
-- Internal Affairs overhaul:
--   * case appeals (auto-granted; SI+ / High Command only)
--   * built-in case documents (replacing the external Google Doc link)
--   * ingested ticket-close logs (replacing the hand-logged ticket system)
--   * IA group rank snapshot on the user (the SI+ gate)

-- ── Enums ────────────────────────────────────────────────────────
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'OVERTURNED';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'APPEALED';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'CHANGES_APPLIED';

-- ── Users: IA group rank snapshot ────────────────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "iaRankName" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "iaRank"     INTEGER;

-- ── Cases: review diffing, built-in document, appeal state ───────
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "reviewSnapshot"  JSONB;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "reviewRevisions" JSONB;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "documentId"      TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "appealedAt"      TIMESTAMP(3);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "appealedById"    TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "appealedByName"  TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "appealReason"    TEXT;

CREATE INDEX IF NOT EXISTS "cases_status_idx"    ON "cases"("status");
CREATE INDEX IF NOT EXISTS "cases_createdAt_idx" ON "cases"("createdAt");

-- ── Case appeals ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "case_appeals" (
    "id"             TEXT NOT NULL,
    "caseId"         TEXT NOT NULL,
    "appealedById"   TEXT NOT NULL,
    "appealedByName" TEXT NOT NULL,
    "appealedByRank" TEXT,
    "reason"         TEXT NOT NULL,
    "liftedActions"  JSONB,
    "hicommOnly"     BOOLEAN NOT NULL DEFAULT false,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "case_appeals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "case_appeals_caseId_idx"    ON "case_appeals"("caseId");
CREATE INDEX IF NOT EXISTS "case_appeals_createdAt_idx" ON "case_appeals"("createdAt");

DO $$ BEGIN
  ALTER TABLE "case_appeals" ADD CONSTRAINT "case_appeals_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "case_appeals" ADD CONSTRAINT "case_appeals_appealedById_fkey"
    FOREIGN KEY ("appealedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Case documents (built-in replacement for the Google Doc) ─────
CREATE TABLE IF NOT EXISTS "case_documents" (
    "id"        TEXT NOT NULL,
    "docRef"    TEXT NOT NULL,
    "authorId"  TEXT NOT NULL,
    "caseId"    TEXT,
    "title"     TEXT NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'DRAFT',
    "data"      JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "case_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "case_documents_docRef_key"  ON "case_documents"("docRef");
CREATE INDEX        IF NOT EXISTS "case_documents_authorId_idx" ON "case_documents"("authorId");
CREATE INDEX        IF NOT EXISTS "case_documents_caseId_idx"   ON "case_documents"("caseId");

DO $$ BEGIN
  ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Ingested ticket-close logs ───────────────────────────────────
CREATE TABLE IF NOT EXISTS "ticket_logs" (
    "id"                    TEXT NOT NULL,
    "messageId"             TEXT NOT NULL,
    "channelId"             TEXT,
    "ticketRef"             TEXT,
    "ticketName"            TEXT,
    "ticketType"            "TicketType" NOT NULL DEFAULT 'GENERAL_SUPPORT',
    "reason"                TEXT,
    "transcriptUrl"         TEXT,
    "creatorDiscordId"      TEXT,
    "creatorUsername"       TEXT,
    "creatorRobloxUsername" TEXT,
    "closerDiscordId"       TEXT,
    "closerUsername"        TEXT,
    "closerUserId"          TEXT,
    "closedAt"              TIMESTAMP(3) NOT NULL,
    "raw"                   JSONB,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_logs_messageId_key"       ON "ticket_logs"("messageId");
CREATE INDEX        IF NOT EXISTS "ticket_logs_closedAt_idx"        ON "ticket_logs"("closedAt");
CREATE INDEX        IF NOT EXISTS "ticket_logs_closerDiscordId_idx" ON "ticket_logs"("closerDiscordId");
CREATE INDEX        IF NOT EXISTS "ticket_logs_closerUserId_idx"    ON "ticket_logs"("closerUserId");
CREATE INDEX        IF NOT EXISTS "ticket_logs_ticketType_idx"      ON "ticket_logs"("ticketType");

-- NOTE: this migration used to drop the hand-logged ticket tables here. It no
-- longer does. Migrations 0035-0058 (the /support help desk) build on "tickets",
-- and they run AFTER this one — dropping it here would break every one of them.
-- The teardown now lives in its own migration at the end of the sequence.
