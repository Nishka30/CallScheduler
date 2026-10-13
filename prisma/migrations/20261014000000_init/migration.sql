-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'CALLING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('PENDING', 'INITIATED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY', 'CANCELED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'APPOINTMENT_BOOKED', 'CALLBACK_REQUESTED', 'VOICEMAIL', 'WRONG_NUMBER', 'DO_NOT_CONTACT', 'NOT_REACHED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "lead_processing" (
    "id" UUID NOT NULL,
    "leadId" VARCHAR(128) NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMPTZ(3),
    "claimedBy" VARCHAR(128),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_processing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_records" (
    "id" UUID NOT NULL,
    "leadId" VARCHAR(128) NOT NULL,
    "personKey" VARCHAR(128),
    "retellCallId" VARCHAR(128),
    "status" "CallStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "CallOutcome",
    "summary" VARCHAR(2000),
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "call_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_cursors" (
    "id" UUID NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "cursor" VARCHAR(512),
    "watermarkAt" TIMESTAMPTZ(3),
    "lastAdvancedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_processing_leadId_key" ON "lead_processing"("leadId");

-- CreateIndex
CREATE INDEX "lead_processing_status_createdAt_idx" ON "lead_processing"("status", "createdAt");

-- CreateIndex
CREATE INDEX "lead_processing_claimedAt_idx" ON "lead_processing"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "call_records_retellCallId_key" ON "call_records"("retellCallId");

-- CreateIndex
CREATE INDEX "call_records_leadId_createdAt_idx" ON "call_records"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "call_records_status_idx" ON "call_records"("status");

-- CreateIndex
CREATE INDEX "call_records_createdAt_idx" ON "call_records"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "integration_cursors_source_key" ON "integration_cursors"("source");

