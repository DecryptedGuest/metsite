-- prisma/migrations/0001_init/migration.sql

CREATE TYPE "Role"       AS ENUM ('IA', 'HICOMM', 'DEVELOPER');
CREATE TYPE "CaseStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
CREATE TYPE "ActionType" AS ENUM ('CREATED', 'APPROVED', 'DENIED', 'DELETED', 'BLACKLISTED', 'UNBLACKLISTED');

CREATE TABLE "users" (
  "id"              TEXT    NOT NULL PRIMARY KEY,
  "discordId"       TEXT    NOT NULL UNIQUE,
  "discordUsername" TEXT    NOT NULL,
  "displayName"     TEXT,
  "discordAvatar"   TEXT,
  "role"            "Role"  NOT NULL DEFAULT 'IA',
  "isBlacklisted"   BOOLEAN NOT NULL DEFAULT false,
  "blacklistReason" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLogin"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "cases" (
  "id"               TEXT         NOT NULL PRIMARY KEY,
  "caseRef"          TEXT         NOT NULL UNIQUE,
  "userId"           TEXT         NOT NULL,
  "officerDiscordId" TEXT,
  "action"           TEXT         NOT NULL,
  "reason"           TEXT         NOT NULL,
  "notes"            TEXT         NOT NULL DEFAULT 'N/A',
  "status"           "CaseStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id")
);

CREATE TABLE "case_actions" (
  "id"          TEXT         NOT NULL PRIMARY KEY,
  "caseId"      TEXT         NOT NULL,
  "actionType"  "ActionType" NOT NULL,
  "performedBy" TEXT         NOT NULL,
  "timestamp"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"       TEXT,
  CONSTRAINT "case_actions_caseId_fkey"      FOREIGN KEY ("caseId")      REFERENCES "cases"("id"),
  CONSTRAINT "case_actions_performedBy_fkey" FOREIGN KEY ("performedBy") REFERENCES "users"("id")
);

CREATE TABLE "case_counter" (
  "id"    INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "count" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "system_settings" (
  "key"       TEXT         NOT NULL PRIMARY KEY,
  "value"     TEXT         NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "case_counter" ("id", "count") VALUES (1, 0);
