-- Parallel CID tryout programme: tag every tryout row with its division so HPC
-- and CID data never mix. Existing rows default to HPC.
ALTER TABLE "tryouts"         ADD COLUMN "division" TEXT NOT NULL DEFAULT 'HPC';
ALTER TABLE "tryouts"         ADD COLUMN "recruitmentMsgId" TEXT;
ALTER TABLE "tryout_commands" ADD COLUMN "division" TEXT NOT NULL DEFAULT 'HPC';
ALTER TABLE "tryout_logs"     ADD COLUMN "division" TEXT NOT NULL DEFAULT 'HPC';

CREATE INDEX IF NOT EXISTS "tryouts_division_idx"     ON "tryouts"("division");
CREATE INDEX IF NOT EXISTS "tryout_logs_division_idx" ON "tryout_logs"("division");
