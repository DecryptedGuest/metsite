CREATE TABLE IF NOT EXISTS "media" (
    "id"         TEXT NOT NULL,
    "title"      TEXT,
    "filename"   TEXT NOT NULL,
    "mimeType"   TEXT NOT NULL,
    "size"       INTEGER NOT NULL,
    "data"       BYTEA NOT NULL,
    "kind"       TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'IA',
    "uploaderId" TEXT NOT NULL,
    "views"      INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "media_createdAt_idx" ON "media"("createdAt");
