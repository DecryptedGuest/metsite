-- Store multi-provider AI-detection results for a marked/scanned final exam.
ALTER TABLE "hpc_exam_submissions" ADD COLUMN IF NOT EXISTS "aiScan" JSONB;
