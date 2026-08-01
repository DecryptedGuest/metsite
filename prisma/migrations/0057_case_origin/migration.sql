-- Case origin discriminator so IA sync never overwrites a natively-created MET
-- case that happens to share a "#N" reference.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'NATIVE';
