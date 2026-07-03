-- CreateEnum
CREATE TYPE "Division" AS ENUM ('CID', 'SCO19', 'IA', 'FLP', 'HPC');

-- CreateEnum
CREATE TYPE "DivisionRank" AS ENUM ('MEMBER', 'LEAD');

-- CreateEnum
CREATE TYPE "CidCaseStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "Sco19DeploymentStatus" AS ENUM ('PENDING_REVIEW', 'SIGNED_OFF', 'REJECTED');

-- CreateEnum
CREATE TYPE "HpcCadetStatus" AS ENUM ('ENROLLED', 'IN_TRAINING', 'PASSED', 'FAILED', 'GRADUATED');

-- DropForeignKey
ALTER TABLE "case_actions" DROP CONSTRAINT "case_actions_caseId_fkey";

-- DropForeignKey
ALTER TABLE "case_actions" DROP CONSTRAINT "case_actions_performedBy_fkey";

-- DropForeignKey
ALTER TABLE "cases" DROP CONSTRAINT "cases_userId_fkey";

-- AlterTable
ALTER TABLE "cases" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "media" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "poster" BYTEA,
ADD COLUMN     "posterMime" TEXT,
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "system_settings" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "divisions" JSONB;

-- CreateTable
CREATE TABLE "cid_cases" (
    "id" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "leadInvestigatorId" TEXT NOT NULL,
    "assignedIds" JSONB,
    "status" "CidCaseStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cid_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cid_case_entries" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cid_case_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sco19_deployments" (
    "id" TEXT NOT NULL,
    "deploymentRef" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "callsign" TEXT NOT NULL,
    "incidentType" TEXT NOT NULL,
    "authorisation" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "Sco19DeploymentStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "signedOffById" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sco19_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flp_shift_logs" (
    "id" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "shiftStart" TIMESTAMP(3) NOT NULL,
    "shiftEnd" TIMESTAMP(3),
    "incidentsCount" INTEGER NOT NULL DEFAULT 0,
    "arrestsCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flp_shift_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hpc_training_records" (
    "id" TEXT NOT NULL,
    "cadetId" TEXT NOT NULL,
    "courseName" TEXT NOT NULL,
    "status" "HpcCadetStatus" NOT NULL DEFAULT 'ENROLLED',
    "instructorId" TEXT,
    "instructorNote" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hpc_training_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cid_cases_caseRef_key" ON "cid_cases"("caseRef");

-- CreateIndex
CREATE UNIQUE INDEX "sco19_deployments_deploymentRef_key" ON "sco19_deployments"("deploymentRef");

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_actions" ADD CONSTRAINT "case_actions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_actions" ADD CONSTRAINT "case_actions_performedBy_fkey" FOREIGN KEY ("performedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cid_cases" ADD CONSTRAINT "cid_cases_leadInvestigatorId_fkey" FOREIGN KEY ("leadInvestigatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cid_case_entries" ADD CONSTRAINT "cid_case_entries_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cid_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sco19_deployments" ADD CONSTRAINT "sco19_deployments_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flp_shift_logs" ADD CONSTRAINT "flp_shift_logs_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hpc_training_records" ADD CONSTRAINT "hpc_training_records_cadetId_fkey" FOREIGN KEY ("cadetId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
