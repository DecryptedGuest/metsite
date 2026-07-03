-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "status" "TicketStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "tickets" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "tickets" ADD COLUMN "reviewedAt" TIMESTAMP(3);
