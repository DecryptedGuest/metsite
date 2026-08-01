-- Tryout server-lock terminology: SLOCKED/UNSLOCKED (shift-lock) → LOCKED/UNLOCKED
-- (Adonis :serverlock state, reported live by the game).
ALTER TABLE "tryouts" ALTER COLUMN "lockState" SET DEFAULT 'LOCKED';
UPDATE "tryouts" SET "lockState" = 'LOCKED'   WHERE "lockState" = 'SLOCKED';
UPDATE "tryouts" SET "lockState" = 'UNLOCKED' WHERE "lockState" = 'UNSLOCKED';
