-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "stepUpAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "webauthnChallenge" TEXT;

-- CreateTable
CREATE TABLE "passkeys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credentialId_key" ON "passkeys"("credentialId");

-- CreateIndex
CREATE INDEX "passkeys_userId_idx" ON "passkeys"("userId");

-- AddForeignKey
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
