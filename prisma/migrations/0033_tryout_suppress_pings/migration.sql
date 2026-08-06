-- Test mode: announce a tryout without pinging the notifications role.
ALTER TABLE "tryouts" ADD COLUMN "suppressPings" BOOLEAN NOT NULL DEFAULT false;
