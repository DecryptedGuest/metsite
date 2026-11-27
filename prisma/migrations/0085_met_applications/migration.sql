-- MET Constable recruitment applications
CREATE TABLE "met_applications" (
  "id" TEXT NOT NULL,
  "appRef" TEXT NOT NULL,
  "applicantId" TEXT NOT NULL,
  "discordId" TEXT NOT NULL,
  "discordUsername" TEXT,
  "robloxId" TEXT NOT NULL,
  "robloxUsername" TEXT,
  "answers" JSONB NOT NULL,
  "groupRequestConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "markedAt" TIMESTAMP(3),
  "markedById" TEXT,
  "markedByName" TEXT,
  "markerNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "met_applications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "met_applications_appRef_key" ON "met_applications"("appRef");
CREATE INDEX "met_applications_status_idx" ON "met_applications"("status");
CREATE INDEX "met_applications_applicantId_idx" ON "met_applications"("applicantId");
CREATE INDEX "met_applications_submittedAt_idx" ON "met_applications"("submittedAt");
ALTER TABLE "met_applications" ADD CONSTRAINT "met_applications_applicantId_fkey"
  FOREIGN KEY ("applicantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
