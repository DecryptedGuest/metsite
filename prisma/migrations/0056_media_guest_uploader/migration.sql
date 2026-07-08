-- Allow guest (anonymous) support-ticket uploads: uploaderId may be null.
ALTER TABLE "media" ALTER COLUMN "uploaderId" DROP NOT NULL;
