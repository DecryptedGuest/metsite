-- Add a non-privileged NONE role so division-only members aren't left with the
-- default IA role (and its IA access). Applied via `prisma db push` at boot.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'NONE';
