-- 0060_remove_website_tickets
-- Tickets no longer work on the website at all.
--
-- Nothing on the site opens, holds or handles a ticket any more. The /support
-- help desk is gone, and so is the hand-logged IA ticket table it was built on.
-- What remains is the READ-ONLY mirror of the Discord ticket-log channel
-- (ticket_logs, created in 0028), which now also carries a supervisor sign-off.
--
-- Approving a ticket log awards NO quota points, so any queued ticket awards go
-- with it.
--
-- Runs LAST in the sequence, after every migration that builds on these tables
-- (0035-0058), which is why the drop couldn't live in 0028 where it started.
--
-- Idempotent: safe to re-run.

-- ── Ticket logs: supervisor sign-off ─────────────────────────────
-- Ingested from Discord, approved or denied on the site. No points either way.
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "status"         "TicketStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "reviewedById"   TEXT;
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "reviewedByName" TEXT;
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "reviewedAt"     TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ticket_logs_status_idx" ON "ticket_logs"("status");

-- ── Tickets award nothing ────────────────────────────────────────
DELETE FROM "quota_awards" WHERE "refType" = 'ticket';

-- ── The support help desk ────────────────────────────────────────
-- support_messages references support_tickets, so it goes first. Media rows
-- survive; they just lose the ticket scope column.
ALTER TABLE "media" DROP COLUMN IF EXISTS "supportTicketId";
DROP TABLE IF EXISTS "support_messages";
DROP TABLE IF EXISTS "support_blacklist";
DROP TABLE IF EXISTS "support_tickets";

-- ── The hand-logged ticket table ─────────────────────────────────
DROP TABLE IF EXISTS "tickets";
DROP TABLE IF EXISTS "ticket_counter";

-- Per-user support-desk preferences (claim greetings, quick replies).
ALTER TABLE "users" DROP COLUMN IF EXISTS "supportPrefs";

-- TicketStatus is deliberately KEPT: ticket_logs.status uses it.
