-- Add SUPERVISOR to the Role enum and update related checks
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR';
