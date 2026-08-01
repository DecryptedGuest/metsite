-- Tryout: post-tryout summary card + in-server roster (co-host picker source).
ALTER TABLE "tryouts" ADD COLUMN "inGamePlayers" JSONB;
ALTER TABLE "tryouts" ADD COLUMN "summary" JSONB;
