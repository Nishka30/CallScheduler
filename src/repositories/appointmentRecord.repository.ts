import type { AppointmentRecord } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * Local persistence for calendar bookings. Stores only operational scheduling
 * state (no customer contact, card, passport or payment data). David's CRM
 * stays the source of truth for the appointment itself.
 *
 * NOTE: the backing table is created by migration
 * `20261019000000_appointment_records`, which is PREPARED but NOT YET APPLIED —
 * it awaits review/approval. These functions therefore run only once that
 * migration is applied (and are exercised by mocked tests until then).
 */

export interface RecordAppointmentInput {
  leadId: string;
  /** Provider appointment id — unique, so re-persisting is idempotent. */
  appointmentId: string;
  agentEmail?: string;
  startsAt?: Date;
  status?: string;
  meetingType?: string;
  decisionMode?: string;
}

/**
 * Records (or idempotently updates) a booked appointment, keyed on the unique
 * provider `appointmentId`. A redelivered/duplicate persist updates the same row
 * rather than creating a second.
 */
export async function recordAppointment(input: RecordAppointmentInput): Promise<AppointmentRecord> {
  const data = {
    leadId: input.leadId,
    ...(input.agentEmail === undefined ? {} : { agentEmail: input.agentEmail }),
    ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.meetingType === undefined ? {} : { meetingType: input.meetingType }),
    ...(input.decisionMode === undefined ? {} : { decisionMode: input.decisionMode }),
  };

  return prisma.appointmentRecord.upsert({
    where: { appointmentId: input.appointmentId },
    update: data,
    create: { appointmentId: input.appointmentId, ...data },
  });
}

/** The most recent appointment recorded for a lead, if any. */
export async function findLatestAppointmentForLead(
  leadId: string,
): Promise<AppointmentRecord | null> {
  return prisma.appointmentRecord.findFirst({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Returns the set of lead ids (from the given list) that have at least one
 * appointment record. Read-only; used by the lifecycle LIST endpoint to mark a
 * lead BOOKED even when the CallRecord outcome was never set to APPOINTMENT_BOOKED
 * (booking is tracked by AppointmentRecord, not inferred from the transcript).
 */
export async function listBookedLeadIds(leadIds: string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const rows = await prisma.appointmentRecord.findMany({
    where: { leadId: { in: leadIds } },
    select: { leadId: true },
  });
  return new Set(rows.map((r) => r.leadId));
}
