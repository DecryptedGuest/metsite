-- Audio (and anything else) pushed to Roblox from the dev panel, plus the asset
-- id that came back. The upload response is the only place Roblox hands the id
-- over, so it is kept rather than reconstructed.
CREATE TABLE IF NOT EXISTS "roblox_uploads" (
  "id"            TEXT NOT NULL,
  "displayName"   TEXT NOT NULL,
  "fileName"      TEXT NOT NULL,
  "mimeType"      TEXT NOT NULL,
  "size"          INTEGER NOT NULL,
  "assetId"       TEXT,
  "operationId"   TEXT,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "error"         TEXT,
  "via"           TEXT,
  "creatorType"   TEXT,
  "creatorId"     TEXT,
  "uploadedById"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"    TIMESTAMP(3),
  CONSTRAINT "roblox_uploads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "roblox_uploads_createdAt_idx" ON "roblox_uploads"("createdAt");
CREATE INDEX IF NOT EXISTS "roblox_uploads_status_idx"    ON "roblox_uploads"("status");

DO $$ BEGIN
  ALTER TABLE "roblox_uploads"
    ADD CONSTRAINT "roblox_uploads_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Roblox finishing an upload is not the same as Roblox approving it: an asset id
-- comes back for audio that is still under review, or already rejected, and that
-- id will not play. APPROVED | REVIEWING | REJECTED.
ALTER TABLE "roblox_uploads" ADD COLUMN IF NOT EXISTS "moderation" TEXT;
