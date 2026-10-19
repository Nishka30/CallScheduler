-- Partial unique index: at most one ACTIVE (unresolved) call attempt per lead.
--
-- This enforces the duplicate-call safeguard at the database level, as the
-- backstop behind the application-level guard in recordCallAttempt(). Prisma
-- cannot express a partial (filtered) unique index in schema.prisma, so this is
-- a hand-written migration, applied via `prisma migrate deploy`.
--
-- The filtered status set matches the UNRESOLVED_STATUSES in
-- src/repositories/callRecord.repository.ts. Terminal states (COMPLETED,
-- FAILED, NO_ANSWER, BUSY, CANCELED) are intentionally excluded, so a lead may
-- have multiple historical attempts but only one in flight at a time.
CREATE UNIQUE INDEX "call_records_active_leadId_key"
  ON "call_records" ("leadId")
  WHERE "status" IN ('PENDING', 'INITIATED', 'IN_PROGRESS', 'UNKNOWN');
