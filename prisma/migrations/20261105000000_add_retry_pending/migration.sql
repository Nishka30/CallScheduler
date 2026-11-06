-- Add RETRY_PENDING to the ProcessingStatus enum (no-op if already present).
ALTER TYPE "ProcessingStatus" ADD VALUE IF NOT EXISTS 'RETRY_PENDING';

-- Persistent no-answer retry scheduling.
ALTER TABLE "lead_processing" ADD COLUMN "nextRetryAt" TIMESTAMPTZ(3);

-- Index used by the retry sweeper to find due retries.
CREATE INDEX "lead_processing_status_nextRetryAt_idx" ON "lead_processing"("status", "nextRetryAt");
