-- One-time QR "install on your phone" session-handoff tokens.
CREATE TABLE "mobile_login_tokens" (
  "id"        TEXT NOT NULL,
  "token"     TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  CONSTRAINT "mobile_login_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mobile_login_tokens_token_key" ON "mobile_login_tokens"("token");
CREATE INDEX "mobile_login_tokens_userId_idx" ON "mobile_login_tokens"("userId");
