-- "We could not tell" is not "not Internal Affairs".
--
-- closerIsIa defaulted to false, so a ticket whose handler had not been resolved
-- yet claimed on its review card that the handler was not IA and would not be
-- paid. That is a rule being announced about a person nobody had identified.
--
-- The column becomes nullable so unknown can be stored as unknown. Existing
-- false values on rows that never identified a handler are reset to NULL; a
-- false on a row that DID name somebody is a real answer and is left alone.
ALTER TABLE "ticket_logs" ALTER COLUMN "closerIsIa" DROP NOT NULL;
ALTER TABLE "ticket_logs" ALTER COLUMN "closerIsIa" DROP DEFAULT;

UPDATE "ticket_logs"
   SET "closerIsIa" = NULL
 WHERE "closerIsIa" = false
   AND "closerDiscordId" IS NULL
   AND "closerUserId"    IS NULL
   AND ("closerRaw" IS NULL OR "closerRaw" = '');
