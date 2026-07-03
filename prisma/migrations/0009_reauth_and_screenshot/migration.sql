-- Force re-auth flag for instant revoke / blacklist
ALTER TABLE "users" ADD COLUMN "mustReauth" BOOLEAN NOT NULL DEFAULT false;

-- Page screenshot attached to capture logs
ALTER TABLE "capture_logs" ADD COLUMN "screenshot" TEXT;
