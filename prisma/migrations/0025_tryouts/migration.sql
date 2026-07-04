-- CreateTable
CREATE TABLE "tryouts" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "hostDiscordId" TEXT NOT NULL,
    "hostName" TEXT NOT NULL,
    "coHostDiscordId" TEXT,
    "coHostName" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "lockState" TEXT NOT NULL DEFAULT 'SLOCKED',
    "privateServerLink" TEXT,
    "privateServerId" TEXT,
    "serverCreatedAt" TIMESTAMP(3),
    "announcementSent" BOOLEAN NOT NULL DEFAULT false,
    "announcementMsgId" TEXT,
    "hostDmMessageId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tryouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tryouts_scheduledAt_idx" ON "tryouts"("scheduledAt");

-- CreateIndex
CREATE INDEX "tryouts_status_idx" ON "tryouts"("status");

-- AddForeignKey
ALTER TABLE "tryouts" ADD CONSTRAINT "tryouts_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
