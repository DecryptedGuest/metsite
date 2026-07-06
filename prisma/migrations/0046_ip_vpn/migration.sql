-- IPs are hidden from users and shown only to developers. Track each account's
-- most recent REAL (non-VPN) IP, and flag which sessions came in over a VPN.
ALTER TABLE "users"    ADD COLUMN IF NOT EXISTS "lastRealIp"   TEXT;
ALTER TABLE "users"    ADD COLUMN IF NOT EXISTS "lastRealIpAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ipVpn"        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "ipOrg"        TEXT;
