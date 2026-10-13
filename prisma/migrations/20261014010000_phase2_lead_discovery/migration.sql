-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProcessingStatus" ADD VALUE 'ELIGIBLE';
ALTER TYPE "ProcessingStatus" ADD VALUE 'SKIPPED';
ALTER TYPE "ProcessingStatus" ADD VALUE 'NEEDS_REVIEW';

-- AlterTable
ALTER TABLE "lead_processing" ADD COLUMN     "decidedAt" TIMESTAMPTZ(3),
ADD COLUMN     "decisionDetail" VARCHAR(300),
ADD COLUMN     "decisionReason" VARCHAR(64),
ADD COLUMN     "leadUpdatedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "integration_cursors" ADD COLUMN     "bootstrapCompletedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "lead_processing_decisionReason_idx" ON "lead_processing"("decisionReason");

