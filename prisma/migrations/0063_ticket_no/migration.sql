-- A short, readable ticket number. Tickety's own id is a random string
-- ("1sRe4HRBFpyrn2sM491") which is unreadable in a table and impossible to say
-- out loud; this is a sequence, shown as #0001.
CREATE SEQUENCE IF NOT EXISTS ticket_log_no_seq START 1;
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "ticketNo" INTEGER;

-- Number what is already there, oldest first, so the ordering means something.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM "ticket_logs" WHERE "ticketNo" IS NULL ORDER BY "closedAt" ASC LOOP
    UPDATE "ticket_logs" SET "ticketNo" = nextval('ticket_log_no_seq') WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_logs_ticketNo_key" ON "ticket_logs"("ticketNo");

-- The closer's name exactly as the log printed it. closerUsername is resolved
-- from the Discord id and can come back null when the lookup fails; this is
-- what the message itself said, which is never null when the log named anybody.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "closerRaw" TEXT;

-- VOID: a log that was ingested before the queue was reset. Not pending, not
-- approved, not denied — simply not somebody's decision to make any more.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);

-- VOID as a real status, so every place that filters on "PENDING" drops these
-- without knowing anything about voiding.
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'VOID';
