-- Live in-game overview snapshot while a tryout is running.
ALTER TABLE "tryouts" ADD COLUMN "liveSnapshot" JSONB;

-- CreateTable
CREATE TABLE "tryout_logs" (
    "id" TEXT NOT NULL,
    "tryoutId" TEXT,
    "hostId" TEXT NOT NULL,
    "hostDiscordId" TEXT,
    "hostName" TEXT NOT NULL,
    "hostRobloxId" TEXT,
    "hostRobloxName" TEXT,
    "coHostName" TEXT,
    "coHostRobloxId" TEXT,
    "startedAt" TIMESTAMP(3),
    "concludedAt" TIMESTAMP(3),
    "attendees" JSONB,
    "events" JSONB,
    "totalAttendees" INTEGER NOT NULL DEFAULT 0,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "leftCount" INTEGER NOT NULL DEFAULT 0,
    "kickedCount" INTEGER NOT NULL DEFAULT 0,
    "strikeCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "pointAwarded" BOOLEAN NOT NULL DEFAULT false,
    "logMessageId" TEXT,
    "gamePayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tryout_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tryout_logs_hostId_idx" ON "tryout_logs"("hostId");
CREATE INDEX "tryout_logs_status_idx" ON "tryout_logs"("status");
CREATE INDEX "tryout_logs_createdAt_idx" ON "tryout_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "tryout_logs" ADD CONSTRAINT "tryout_logs_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
