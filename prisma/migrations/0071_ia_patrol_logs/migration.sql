-- IA patrol logs filed on the website, and the Discord mirror both log kinds get.
--
-- Two things here:
--
--   ia_patrol_logs — one officer's shift, filed on the site and signed off on the
--   site. Deliberately NOT patrol_logs, which is a reading of a message somebody
--   posted in Discord, keyed on its message id and signed off by a reaction.
--   Folding them together would mean a messageId column that sometimes means
--   "where this came from" and sometimes "where we put it".
--
--   mirrorChannelId / mirrorMessageId on both — where the Discord copy of the log
--   lives. It is posted as pending when the log is filed and the SAME message is
--   edited when a supervisor decides, so the channel carries one message per log
--   whose current state is the truth. Without the id there is nothing to edit and
--   the channel keeps a pending embed for a log that was decided days ago.
--
-- Written idempotently (IF NOT EXISTS throughout) because this deployment syncs
-- its schema with `prisma db push` rather than by applying migrations in order,
-- so this file has to be safe to run against a database that already has some or
-- all of it.

CREATE TABLE IF NOT EXISTS "ia_patrol_logs" (
  "id"               TEXT NOT NULL,
  -- Sequential and human-readable: "PTL-0042".
  "patrolRef"        TEXT NOT NULL,
  "officerId"        TEXT NOT NULL,
  -- Snapshotted, so a log read in three weeks shows the name it was filed under.
  "officerDiscordId" TEXT,
  "officerName"      TEXT,
  "startedAt"        TIMESTAMP(3) NOT NULL,
  "endedAt"          TIMESTAMP(3) NOT NULL,
  -- Computed from the two, midnight-crossing included. Never accepted from the
  -- form: a typed duration lets a ten-minute patrol be filed as six hours.
  "totalMinutes"     INTEGER NOT NULL,
  "area"             TEXT,
  -- Who else was out. Recorded for the reviewer and paid NOTHING: on a joint
  -- patrol both officers file their own log, so paying partners as well would pay
  -- each of them twice for the same shift.
  "partners"         JSONB,
  "partnerCount"     INTEGER NOT NULL DEFAULT 0,
  "notes"            TEXT,
  "proof"            JSONB,
  "pointsEach"       INTEGER NOT NULL DEFAULT 2,
  -- One XP per completed block of PATROL_XP_MINUTES, the same rule the Discord
  -- patrol logs use. Frozen at filing so a later change to the rule cannot
  -- silently rewrite what a pending log is worth.
  "xpEach"           INTEGER NOT NULL DEFAULT 0,
  "xpAward"          JSONB,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "reviewedById"     TEXT,
  "reviewedByName"   TEXT,
  "reviewedAt"       TIMESTAMP(3),
  "reviewNote"       TEXT,
  "voidedAt"         TIMESTAMP(3),
  "voidedById"       TEXT,
  "voidedReason"     TEXT,
  "mirrorChannelId"  TEXT,
  "mirrorMessageId"  TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ia_patrol_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ia_patrol_logs_patrolRef_key" ON "ia_patrol_logs"("patrolRef");
CREATE INDEX IF NOT EXISTS "ia_patrol_logs_startedAt_idx"  ON "ia_patrol_logs"("startedAt");
CREATE INDEX IF NOT EXISTS "ia_patrol_logs_officerId_idx"  ON "ia_patrol_logs"("officerId");
CREATE INDEX IF NOT EXISTS "ia_patrol_logs_status_idx"     ON "ia_patrol_logs"("status");

-- The officer relation. Added separately and guarded, because a re-run must not
-- fail on a constraint that is already there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ia_patrol_logs_officerId_fkey'
  ) THEN
    ALTER TABLE "ia_patrol_logs"
      ADD CONSTRAINT "ia_patrol_logs_officerId_fkey"
      FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- And the mirror on the event logs, which predate this.
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "mirrorChannelId" TEXT;
ALTER TABLE "ia_event_logs" ADD COLUMN IF NOT EXISTS "mirrorMessageId" TEXT;
