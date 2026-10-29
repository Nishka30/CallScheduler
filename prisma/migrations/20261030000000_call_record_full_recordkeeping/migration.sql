-- Complete call recordkeeping: extend call_records with the full call record
-- (transcript, recording, analysis, provider metadata) and CRM note-delivery
-- tracking. Backward-compatible: every column is nullable or has a default, so
-- existing rows and in-flight code keep working. No column is dropped or renamed.

ALTER TABLE "call_records"
  ADD COLUMN "transcript"          TEXT,
  ADD COLUMN "transcriptJson"      JSONB,
  ADD COLUMN "analysis"            JSONB,
  ADD COLUMN "recordingUrl"        VARCHAR(1024),
  ADD COLUMN "disconnectionReason" VARCHAR(64),
  ADD COLUMN "direction"           VARCHAR(16),
  ADD COLUMN "customerTz"          VARCHAR(64),
  ADD COLUMN "noteStatus"          VARCHAR(16),
  ADD COLUMN "noteError"           VARCHAR(200),
  ADD COLUMN "noteAttempts"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "noteLastAttemptAt"   TIMESTAMPTZ(3),
  ADD COLUMN "noteDeliveredAt"     TIMESTAMPTZ(3);

-- Lets a reconciliation query find terminal calls whose note has not been sent.
CREATE INDEX "call_records_noteStatus_idx" ON "call_records" ("noteStatus");
