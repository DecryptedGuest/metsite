-- A concluded tryout should always produce a log, even when the in-game host has
-- no linked site account. Make hostId optional and add the proof field.
ALTER TABLE "tryout_logs" ALTER COLUMN "hostId" DROP NOT NULL;
ALTER TABLE "tryout_logs" ADD COLUMN IF NOT EXISTS "proof" TEXT;
