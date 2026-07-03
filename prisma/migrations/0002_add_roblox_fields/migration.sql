-- Migration: add robloxUserId and robloxUsername to cases table
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "robloxUserId"   TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "robloxUsername" TEXT;
