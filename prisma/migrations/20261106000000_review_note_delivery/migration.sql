-- Persistent CRM review-note delivery state (additive, non-destructive).
ALTER TABLE "lead_processing"
  ADD COLUMN "reviewNoteStatus" VARCHAR(16),
  ADD COLUMN "reviewNoteReason" VARCHAR(64),
  ADD COLUMN "reviewNoteDetail" VARCHAR(300),
  ADD COLUMN "reviewNoteAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewNoteNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "reviewNoteError" VARCHAR(200),
  ADD COLUMN "reviewNoteSentAt" TIMESTAMPTZ(3);

CREATE INDEX "lead_processing_reviewNoteStatus_reviewNoteNextAttemptAt_idx"
  ON "lead_processing"("reviewNoteStatus", "reviewNoteNextAttemptAt");
