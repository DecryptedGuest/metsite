-- Internal Affairs events, logged on the site. Submitting one awards every
-- attendee their quota points immediately — there is no approval step — so the
-- row carries enough to audit the award after the fact.
CREATE TABLE IF NOT EXISTS "ia_event_logs" (
  "id"            TEXT PRIMARY KEY,
  "eventRef"      TEXT NOT NULL,
  "eventType"     TEXT NOT NULL,
  "title"         TEXT,
  "hostId"        TEXT NOT NULL,
  "hostDiscordId" TEXT,
  "hostName"      TEXT,
  "coHostName"    TEXT,
  "startedAt"     TIMESTAMP(3) NOT NULL,
  "durationMins"  INTEGER,
  "attendees"     JSONB NOT NULL,
  "attendeeCount" INTEGER NOT NULL DEFAULT 0,
  "pointsEach"    INTEGER NOT NULL DEFAULT 2,
  "notes"         TEXT,
  "proof"         JSONB,
  "voidedAt"      TIMESTAMP(3),
  "voidedById"    TEXT,
  "voidedReason"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ia_event_logs_eventRef_key" ON "ia_event_logs"("eventRef");
CREATE INDEX IF NOT EXISTS "ia_event_logs_startedAt_idx" ON "ia_event_logs"("startedAt");
CREATE INDEX IF NOT EXISTS "ia_event_logs_hostId_idx"    ON "ia_event_logs"("hostId");

DO $$ BEGIN
  ALTER TABLE "ia_event_logs"
    ADD CONSTRAINT "ia_event_logs_hostId_fkey"
    FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
