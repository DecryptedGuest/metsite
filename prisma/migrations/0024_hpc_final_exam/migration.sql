-- AlterTable
ALTER TABLE "users" ADD COLUMN     "metRoleIds" JSONB;

-- CreateTable
CREATE TABLE "hpc_exam_submissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "discordUsername" TEXT,
    "robloxUsername" TEXT,
    "answers" JSONB NOT NULL,
    "detection" JSONB,
    "flags" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scores" JSONB,
    "score" INTEGER,
    "maxScore" INTEGER NOT NULL,
    "percentage" INTEGER,
    "markerNote" TEXT,
    "markedById" TEXT,
    "markedByName" TEXT,
    "markedAt" TIMESTAMP(3),
    "resultMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hpc_exam_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hpc_exam_submissions_userId_idx" ON "hpc_exam_submissions"("userId");

-- CreateIndex
CREATE INDEX "hpc_exam_submissions_status_idx" ON "hpc_exam_submissions"("status");

-- CreateIndex
CREATE INDEX "hpc_exam_submissions_createdAt_idx" ON "hpc_exam_submissions"("createdAt");

-- AddForeignKey
ALTER TABLE "hpc_exam_submissions" ADD CONSTRAINT "hpc_exam_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
