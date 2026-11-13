-- Append-only lead lifecycle history (additive, non-destructive).
-- Durable audit trail so "what happened to this lead" is answerable from the
-- database independent of rotating console logs. Stores NO personal data.

-- CreateTable
CREATE TABLE "lead_lifecycle_events" (
    "id" UUID NOT NULL,
    "leadId" VARCHAR(128) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32),
    "reason" VARCHAR(64),
    "detail" VARCHAR(300),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_lifecycle_events_leadId_createdAt_idx" ON "lead_lifecycle_events"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_lifecycle_events_createdAt_idx" ON "lead_lifecycle_events"("createdAt");
