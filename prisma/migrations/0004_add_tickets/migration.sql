-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('GENERAL_SUPPORT', 'HICOMM', 'OFFICER_REPORT');
CREATE TABLE "ticket_counter" ("id" INTEGER NOT NULL DEFAULT 1, "count" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "ticket_counter_pkey" PRIMARY KEY ("id"));
INSERT INTO "ticket_counter" VALUES (1, 0) ON CONFLICT DO NOTHING;
CREATE TABLE "tickets" ("id" TEXT NOT NULL, "ticketRef" TEXT NOT NULL, "userId" TEXT NOT NULL, "robloxUsername" TEXT NOT NULL, "ticketType" "TicketType" NOT NULL, "submittedAt" TEXT NOT NULL, "timezone" TEXT NOT NULL, "conclusion" TEXT NOT NULL, "proofImages" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "tickets_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "tickets_ticketRef_key" ON "tickets"("ticketRef");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
