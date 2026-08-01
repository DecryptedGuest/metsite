-- Support staff tools: ticket priority + escalation flag for the IA handling panel.
ALTER TABLE "support_tickets" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "support_tickets" ADD COLUMN "escalated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "support_tickets" ADD COLUMN "escalatedNote" TEXT;
