-- Ticket logs now come from three servers: the MET/IA one, CID and SCO-19.
-- Internal Affairs handles all of them, so they share one queue and the tag
-- says where each came from.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "division"   TEXT NOT NULL DEFAULT 'MET';
-- The handler's rank as their nickname printed it in that server, so a ticket
-- closed by a division officer still names who at what rank.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "closerRank" TEXT;
-- Whether the handler is Internal Affairs. Quota points are IA's, so a ticket a
-- division officer handled is logged and reviewed but pays nobody.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "closerIsIa" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "ticket_logs_division_idx" ON "ticket_logs"("division");
