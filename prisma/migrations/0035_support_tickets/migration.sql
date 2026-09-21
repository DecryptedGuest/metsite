-- Support ticket help desk (/support): tickets + their message threads.
CREATE TABLE "support_tickets" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'INTAKE',
  "openerId" TEXT NOT NULL,
  "openerDiscordId" TEXT,
  "openerName" TEXT NOT NULL,
  "intake" JSONB,
  "claimedById" TEXT,
  "claimedByName" TEXT,
  "claimedAt" TIMESTAMP(3),
  "closedById" TEXT,
  "closedByName" TEXT,
  "closeReason" TEXT,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_tickets_type_idx"    ON "support_tickets"("type");
CREATE INDEX "support_tickets_status_idx"  ON "support_tickets"("status");
CREATE INDEX "support_tickets_opener_idx"  ON "support_tickets"("openerId");

CREATE TABLE "support_messages" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "authorId" TEXT,
  "authorName" TEXT NOT NULL,
  "authorKind" TEXT NOT NULL DEFAULT 'STAFF',
  "body" TEXT,
  "attachments" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_messages_ticket_idx" ON "support_messages"("ticketId");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
