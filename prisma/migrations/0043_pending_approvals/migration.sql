-- Four-eyes: high-stakes actions proposed by one dev, approved by another.
CREATE TABLE "pending_approvals" (
  "id"              TEXT NOT NULL,
  "action"          TEXT NOT NULL,
  "params"          JSONB,
  "reason"          TEXT,
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "requestedById"   TEXT,
  "requestedByName" TEXT,
  "resolvedById"    TEXT,
  "resolvedByName"  TEXT,
  "resolvedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pending_approvals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pending_approvals_status_idx" ON "pending_approvals"("status");
