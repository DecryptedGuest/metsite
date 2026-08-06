-- Patrol/event log date (parsed from the log, else the message-sent date) + midnight-crossover flag.
ALTER TABLE "patrol_logs" ADD COLUMN IF NOT EXISTS "logDate" TIMESTAMP(3);
ALTER TABLE "patrol_logs" ADD COLUMN IF NOT EXISTS "crossedMidnight" BOOLEAN NOT NULL DEFAULT false;
