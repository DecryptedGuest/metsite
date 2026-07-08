-- Per-user IA support desk preferences: editable claim greetings + quick replies.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "supportPrefs" JSONB;
