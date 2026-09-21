-- Reserved-server "Join" flow: store the reserved server access code on the
-- tryout, and a host-toggled joinable flag that controls whether the launch
-- link is shown in the announcement / whether /joincode hands out the code.
ALTER TABLE "tryouts" ADD COLUMN IF NOT EXISTS "accessCode" TEXT;
ALTER TABLE "tryouts" ADD COLUMN IF NOT EXISTS "joinable" BOOLEAN NOT NULL DEFAULT false;
