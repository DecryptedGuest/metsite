-- Tamper-evidence: a per-row HMAC over the audit row's fields.
ALTER TABLE "audit_log" ADD COLUMN "hash" TEXT;
