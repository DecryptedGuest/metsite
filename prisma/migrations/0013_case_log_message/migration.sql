-- Remember the posted Administrative Log message so edits can update it in place
ALTER TABLE "cases" ADD COLUMN "logMessageId" TEXT;
