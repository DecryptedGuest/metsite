-- CreateTable
CREATE TABLE "met_member_profiles" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "discordUsername" TEXT,
    "metNickname" TEXT,
    "robloxId" TEXT,
    "robloxUsername" TEXT,
    "roles" JSONB,
    "perms" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "met_member_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "met_punishments" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "issuedById" TEXT,
    "issuedBy" TEXT,
    "caseRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "met_punishments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "met_member_profiles_discordId_key" ON "met_member_profiles"("discordId");

-- CreateIndex
CREATE INDEX "met_punishments_discordId_idx" ON "met_punishments"("discordId");

-- CreateIndex
CREATE INDEX "met_punishments_issuedAt_idx" ON "met_punishments"("issuedAt");
