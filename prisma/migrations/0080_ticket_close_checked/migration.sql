-- Mark which rows have been checked against their original Discord message.
--
-- The check re-reads the message to decide whether the row is really a ticket
-- close. That is one Discord REST call per row, so it has to happen once per
-- row and be remembered; without a stamp the pass restarted from the top on
-- every boot, never reached the end, and so never recorded that it had run.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "closeChecked" TIMESTAMP(3);

-- Rows the previous pass already voided as non-closes are settled.
UPDATE "ticket_logs" SET "closeChecked" = NOW()
 WHERE "closeChecked" IS NULL AND "voidedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ticket_logs_closeChecked_idx" ON "ticket_logs"("closeChecked");
