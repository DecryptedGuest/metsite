-- QR sign-in anti-phishing: initiator device context, number-match code, and a
-- secret hash that binds status polling to the browser that started the flow.
ALTER TABLE "login_challenges" ADD COLUMN IF NOT EXISTS "userAgent"  TEXT;
ALTER TABLE "login_challenges" ADD COLUMN IF NOT EXISTS "matchCode"  TEXT;
ALTER TABLE "login_challenges" ADD COLUMN IF NOT EXISTS "secretHash" TEXT;
