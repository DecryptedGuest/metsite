-- Site → game management commands for a live tryout (strike/pass/fail/kick from the site).
CREATE TABLE "tryout_commands" (
    "id" TEXT NOT NULL,
    "tryoutId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetRobloxId" TEXT,
    "targetUsername" TEXT,
    "detail" TEXT,
    "issuedById" TEXT,
    "issuedByName" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tryout_commands_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tryout_commands_tryoutId_applied_idx" ON "tryout_commands"("tryoutId", "applied");
