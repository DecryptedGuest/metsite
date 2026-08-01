-- Store the host's Roblox identity on the tryout (for the in-game TryoutTV board).
ALTER TABLE "tryouts" ADD COLUMN "hostRobloxId" TEXT;
ALTER TABLE "tryouts" ADD COLUMN "hostRobloxName" TEXT;
