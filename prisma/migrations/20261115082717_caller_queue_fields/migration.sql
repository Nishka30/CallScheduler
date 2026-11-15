-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('POLL', 'QUEUE');

-- AlterTable
ALTER TABLE "lead_processing" ADD COLUMN     "callBeforeAt" TIMESTAMPTZ(3),
ADD COLUMN     "callInProgressSentAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastFinalStatus" VARCHAR(32),
ADD COLUMN     "offeredAt" TIMESTAMPTZ(3),
ADD COLUMN     "source" "LeadSource" NOT NULL DEFAULT 'POLL',
ADD COLUMN     "statusReportAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "statusReportError" VARCHAR(200),
ADD COLUMN     "statusReportStatus" VARCHAR(16),
ADD COLUMN     "statusReportedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "lead_processing_source_callBeforeAt_idx" ON "lead_processing"("source", "callBeforeAt");

-- CreateIndex
CREATE INDEX "lead_processing_statusReportStatus_idx" ON "lead_processing"("statusReportStatus");
