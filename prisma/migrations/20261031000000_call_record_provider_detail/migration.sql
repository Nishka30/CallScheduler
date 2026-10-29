-- Capture the remaining Retell call detail our backend should own as the source
-- of truth: agent identity/version, extra recording/log URLs, the tool-call
-- transcript, and curated cost/latency diagnostics. Backward-compatible: every
-- column is nullable, nothing is dropped or renamed.
--
-- Deliberately NOT added: caller/recipient phone numbers and the full raw payload.
-- Phone numbers are PII the project minimizes everywhere; the conversation itself
-- is already preserved in transcript / transcriptJson / transcriptWithToolCalls /
-- analysis, so a full-payload duplicate is unjustified. providerMetadata holds only
-- non-PII diagnostics (cost, latency, call type).

ALTER TABLE "call_records"
  ADD COLUMN "agentId"                  VARCHAR(128),
  ADD COLUMN "agentVersion"             INTEGER,
  ADD COLUMN "transcriptWithToolCalls"  JSONB,
  ADD COLUMN "recordingMultiChannelUrl" VARCHAR(1024),
  ADD COLUMN "publicLogUrl"             VARCHAR(1024),
  ADD COLUMN "providerMetadata"         JSONB;
