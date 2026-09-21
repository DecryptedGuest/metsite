-- Distinguish patrol logs from event logs; event logs award a MET point on approval.
ALTER TABLE "patrol_logs" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'PATROL';
ALTER TABLE "patrol_logs" ADD COLUMN "pointAwarded" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "patrol_logs_type_idx" ON "patrol_logs"("type");
