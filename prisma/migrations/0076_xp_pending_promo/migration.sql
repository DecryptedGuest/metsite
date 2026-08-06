-- An unseen promotion to celebrate the next time /xp is run or the profile opens.
ALTER TABLE "met_xp" ADD COLUMN IF NOT EXISTS "pendingPromo" JSONB;
