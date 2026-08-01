-- Support: IA can issue a ticket blacklist against a guest opener's IP/browser.
-- Capture the opener's network identity on the ticket, and store blacklist rows.
ALTER TABLE "support_tickets" ADD COLUMN "openerIp" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "openerFp" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "openerUa" TEXT;

CREATE TABLE "support_blacklist" (
  "id"              TEXT NOT NULL,
  "ip"              TEXT,
  "fingerprint"     TEXT,
  "ua"              TEXT,
  "ticketId"        TEXT,
  "openerName"      TEXT,
  "openerDiscordId" TEXT,
  "reason"          TEXT,
  "issuedById"      TEXT,
  "issuedByName"    TEXT,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "liftedById"      TEXT,
  "liftedByName"    TEXT,
  "liftedAt"        TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_blacklist_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_blacklist_ip_idx" ON "support_blacklist"("ip");
CREATE INDEX "support_blacklist_fingerprint_idx" ON "support_blacklist"("fingerprint");
CREATE INDEX "support_blacklist_active_idx" ON "support_blacklist"("active");
