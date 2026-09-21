-- 0059_schema_catchup
-- Brings the migration history back in line with prisma/schema.prisma.
--
-- The schema had drifted ahead of the migrations: the CAD dispatch tables, the
-- developer MET-rank override / panel grants, the support-desk message edits
-- and blacklist link, quota_awards.division and several other columns existed
-- in schema.prisma with no migration to create them. That works if the database
-- was built with `prisma db push`, but a fresh `migrate deploy` produced a
-- database the Prisma client couldn't talk to.
--
-- Generated with `prisma migrate diff` against the full migration sequence, then
-- made idempotent so it is a no-op on a database that already has these objects.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CadUnitStatus" AS ENUM ('OFF_DUTY', 'AVAILABLE', 'EN_ROUTE', 'ON_SCENE', 'BUSY', 'MEAL_BREAK', 'URGENT_ASSISTANCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CadGrade" AS ENUM ('I', 'S', 'E', 'R');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CadIncidentStatus" AS ENUM ('OPEN', 'ASSIGNED', 'ON_SCENE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DropForeignKey
ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "media_uploaderId_fkey";

-- DropForeignKey
ALTER TABLE "tryout_logs" DROP CONSTRAINT IF EXISTS "tryout_logs_hostId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "patrol_logs_type_idx";

-- AlterTable
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "supportTicketId" TEXT;

-- AlterTable
ALTER TABLE "quota_awards" ADD COLUMN IF NOT EXISTS "division" TEXT NOT NULL DEFAULT 'IA';

-- AlterTable
ALTER TABLE "support_blacklist" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- AlterTable
ALTER TABLE "support_messages" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "replyToId" TEXT;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'NATIVE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "metRankNatural" JSONB,
ADD COLUMN IF NOT EXISTS "metRankOverride" JSONB,
ADD COLUMN IF NOT EXISTS "panelGrant" JSONB,
ALTER COLUMN "role" SET DEFAULT 'NONE';

-- CreateTable
CREATE TABLE IF NOT EXISTS "cad_units" (
    "id" TEXT NOT NULL,
    "callsign" TEXT NOT NULL,
    "discordUserId" TEXT,
    "userId" TEXT,
    "officerName" TEXT NOT NULL,
    "status" "CadUnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "currentIncidentId" TEXT,
    "bookedOnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "cad_incidents" (
    "id" TEXT NOT NULL,
    "cadRef" TEXT NOT NULL,
    "grade" "CadGrade" NOT NULL,
    "category" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "CadIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "createdByName" TEXT,
    "closedOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "cad_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "cad_incident_logs" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "unitId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_incident_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "cad_vehicle_records" (
    "id" TEXT NOT NULL,
    "vrm" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "registeredKeeper" TEXT NOT NULL,
    "taxStatus" TEXT NOT NULL,
    "motStatus" TEXT NOT NULL,
    "insuranceStatus" TEXT NOT NULL,
    "markers" TEXT[],
    "stolen" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cad_vehicle_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "cad_person_records" (
    "id" TEXT NOT NULL,
    "forename" TEXT NOT NULL,
    "surname" TEXT NOT NULL,
    "dob" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "warningMarkers" TEXT[],
    "wanted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "cad_person_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "cad_units_callsign_key" ON "cad_units"("callsign");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cad_units_status_idx" ON "cad_units"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cad_units_discordUserId_idx" ON "cad_units"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "cad_incidents_cadRef_key" ON "cad_incidents"("cadRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cad_incidents_status_idx" ON "cad_incidents"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cad_incidents_grade_idx" ON "cad_incidents"("grade");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cad_incident_logs_incidentId_idx" ON "cad_incident_logs"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "cad_vehicle_records_vrm_key" ON "cad_vehicle_records"("vrm");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cad_person_records_surname_idx" ON "cad_person_records"("surname");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "media_supportTicketId_idx" ON "media"("supportTicketId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "support_blacklist_userId_idx" ON "support_blacklist"("userId");

-- RenameForeignKey
DO $$ BEGIN
    ALTER TABLE "support_messages" RENAME CONSTRAINT "support_messages_ticket_fkey" TO "support_messages_ticketId_fkey";
EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "media" ADD CONSTRAINT "media_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "tryout_logs" ADD CONSTRAINT "tryout_logs_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "cad_incident_logs" ADD CONSTRAINT "cad_incident_logs_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "cad_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RenameIndex
DO $$ BEGIN
    ALTER INDEX "support_messages_ticket_idx" RENAME TO "support_messages_ticketId_idx";
EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- RenameIndex
DO $$ BEGIN
    ALTER INDEX "support_tickets_opener_idx" RENAME TO "support_tickets_openerId_idx";
EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;


