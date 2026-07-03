-- CreateTable: developer-authorised access grants (site access without Discord roles)
CREATE TABLE "access_grants" (
  "id"        TEXT NOT NULL,
  "discordId" TEXT NOT NULL,
  "role"      "Role" NOT NULL DEFAULT 'IA',
  "note"      TEXT,
  "grantedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "access_grants_discordId_key" ON "access_grants"("discordId");
