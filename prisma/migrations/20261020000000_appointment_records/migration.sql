-- CreateTable
CREATE TABLE "appointment_records" (
    "id" UUID NOT NULL,
    "leadId" VARCHAR(128) NOT NULL,
    "appointmentId" VARCHAR(128) NOT NULL,
    "agentEmail" VARCHAR(320),
    "startsAt" TIMESTAMPTZ(3),
    "status" VARCHAR(64),
    "meetingType" VARCHAR(32),
    "decisionMode" VARCHAR(16),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointment_records_appointmentId_key" ON "appointment_records"("appointmentId");

-- CreateIndex
CREATE INDEX "appointment_records_leadId_idx" ON "appointment_records"("leadId");

