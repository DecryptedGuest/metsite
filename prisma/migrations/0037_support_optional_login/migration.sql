-- Support: login is optional. Anonymous openers hold a per-ticket token instead
-- of a user id, so openerId becomes nullable and we add openerToken.
ALTER TABLE "support_tickets" ALTER COLUMN "openerId" DROP NOT NULL;
ALTER TABLE "support_tickets" ADD COLUMN "openerToken" TEXT;
