-- Roblox group audit log, mirrored.
--
-- Roblox gives audit entries no id of their own, so "fingerprint" is ours: a hash
-- over the timestamp, the action type, the actor and the description. The UNIQUE
-- index on it is what makes the poller safe to run again and safe to overlap with
-- itself — re-reading the same page inserts nothing and so posts nothing.
CREATE TABLE IF NOT EXISTS "group_audit_entries" (
  "id"              TEXT NOT NULL,
  "groupId"         TEXT NOT NULL,
  "actionType"      TEXT NOT NULL,
  "actorId"         TEXT,
  "actorName"       TEXT,
  "actorRank"       INTEGER,
  "actorRankName"   TEXT,
  "targetId"        TEXT,
  "targetName"      TEXT,
  "description"     JSONB,
  "occurredAt"      TIMESTAMP(3) NOT NULL,
  "fingerprint"     TEXT NOT NULL,
  "messageId"       TEXT,
  "postedAt"        TIMESTAMP(3),
  "matchedAuditId"  TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_audit_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_audit_entries_fingerprint_key"
  ON "group_audit_entries"("fingerprint");
CREATE INDEX IF NOT EXISTS "group_audit_entries_groupId_occurredAt_idx"
  ON "group_audit_entries"("groupId", "occurredAt");
CREATE INDEX IF NOT EXISTS "group_audit_entries_actionType_idx"
  ON "group_audit_entries"("actionType");
CREATE INDEX IF NOT EXISTS "group_audit_entries_targetId_idx"
  ON "group_audit_entries"("targetId");
CREATE INDEX IF NOT EXISTS "group_audit_entries_actorId_idx"
  ON "group_audit_entries"("actorId");
CREATE INDEX IF NOT EXISTS "group_audit_entries_postedAt_idx"
  ON "group_audit_entries"("postedAt");
