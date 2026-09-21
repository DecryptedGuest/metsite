-- IA events are reviewed before anybody is paid. Filing one used to BE the
-- award, which meant the person who ran the event decided what it was worth.
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "reviewedById" TEXT;
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "reviewedByName" TEXT;
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

-- Events filed before this shipped were paid on submission, so they are
-- already settled. Marking them APPROVED keeps them out of the new queue
-- rather than presenting a supervisor with a backlog of things that have
-- already been paid.
UPDATE "ia_event_logs" SET "status" = 'APPROVED' WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "ia_event_logs_status_idx" ON "ia_event_logs"("status");
