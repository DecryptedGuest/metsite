CREATE TABLE IF NOT EXISTS "automated_tryouts" (
  "id" TEXT NOT NULL,
  "gameSessionId" TEXT,
  "tryoutId" TEXT,
  "division" TEXT NOT NULL DEFAULT 'HPC',
  "hostName" TEXT NOT NULL DEFAULT 'INSTRUCTOR',
  "coHostName" TEXT,
  "attendeeRobloxId" TEXT NOT NULL,
  "attendeeName" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "strikes" INTEGER NOT NULL DEFAULT 0,
  "quizScore" INTEGER,
  "quizTotal" INTEGER,
  "flags" TEXT,
  "placeId" TEXT,
  "privateServerId" TEXT,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "payload" TEXT NOT NULL,
  "logChannelId" TEXT,
  "logMessageId" TEXT,
  "actionedById" TEXT,
  "actionedAt" TIMESTAMP(3),
  "actionKind" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automated_tryouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "automated_tryouts_gameSessionId_key" ON "automated_tryouts"("gameSessionId");
CREATE INDEX IF NOT EXISTS "automated_tryouts_attendeeRobloxId_idx" ON "automated_tryouts"("attendeeRobloxId");
