import { z, type ZodError } from 'zod';
import { LeadApiError } from './errors.js';

/**
 * Defensive schemas for the Lead API **team** calendar endpoints (Oct 20 brief).
 *
 * Field names verified against the live `GET /api/crm/leads/<id>/team-slots`
 * response (2026-10-20). The older per-agent `GET /api/crm/agents` /
 * `POST /api/crm/appointments` path is superseded and intentionally gone.
 * Unknown fields are preserved via `.passthrough()`; nothing is invented.
 */

/** `decision.mode` routing values from the brief. */
export const DECISION_MODES = ['owner', 'pool', 'none'] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

/** Meeting channels the booking endpoint accepts. */
export const MEETING_TYPES = ['phone', 'whatsapp', 'video'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

/** One slot from `team-slots`: `{ starts_at, ends_at, agents[], local }`. */
export const teamSlotSchema = z
  .object({
    starts_at: z.string().min(1),
    ends_at: z.string().nullish(),
    /** Agent emails eligible for this slot (pool mode may list several). */
    agents: z.array(z.string()).nullish(),
    /** Readable time in the customer's zone, for speaking only. */
    local: z.string().nullish(),
  })
  .passthrough();
export type TeamSlot = z.infer<typeof teamSlotSchema>;

/** Agent sub-object (`agent.name` is read back to the customer). */
const agentRefSchema = z
  .object({
    email: z.string().nullish(),
    name: z.string().nullish(),
    first_name: z.string().nullish(),
  })
  .passthrough();

const decisionSchema = z
  .object({
    mode: z.string().min(1),
    fallback: z.boolean().nullish(),
    reason: z.string().nullish(),
    /**
     * The chosen owner's EMAIL (string) in `owner` mode, or `null` in
     * `pool`/`none` mode — NOT an agent object. The full agent object is the
     * top-level `owner` field below. Verified against the live owner-mode
     * response on 2026-10-28 (`decision.owner` was an email string).
     */
    owner: z.string().nullish(),
  })
  .passthrough();

/** Full `GET /api/crm/leads/<id>/team-slots` response. */
export const teamSlotsResponseSchema = z
  .object({
    lead_id: z.union([z.string(), z.number()]).transform(String).nullish(),
    brand: z.string().nullish(),
    decision: decisionSchema,
    /** Populated in owner mode with the lead's agent; null in pool/none. */
    owner: agentRefSchema.nullish(),
    agents: z.array(agentRefSchema).nullish(),
    slots: z.array(teamSlotSchema),
  })
  .passthrough();
export type TeamSlotsResponse = z.infer<typeof teamSlotsResponseSchema>;

/** `POST /api/crm/appointments/team` (201): `{ appointment, agent, decision, free_agents[] }`. */
export const teamAppointmentResponseSchema = z
  .object({
    appointment: z
      .object({
        id: z.union([z.string().min(1), z.number().int()]).transform(String),
        starts_at: z.string().nullish(),
        status: z.string().nullish(),
      })
      .passthrough(),
    agent: agentRefSchema.nullish(),
    decision: decisionSchema.nullish(),
    free_agents: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type TeamAppointmentResponse = z.infer<typeof teamAppointmentResponseSchema>;

/** `PATCH /api/crm/appointments/<id>` response (reschedule/cancel). */
export const appointmentPatchResponseSchema = z
  .object({
    id: z
      .union([z.string().min(1), z.number().int()])
      .transform(String)
      .nullish(),
    status: z.string().nullish(),
    starts_at: z.string().nullish(),
  })
  .passthrough();

export function parseTeamSlots(payload: unknown, path: string): TeamSlotsResponse {
  const r = teamSlotsResponseSchema.safeParse(payload);
  if (!r.success) throw contractError('team-slots', path, r.error);
  return r.data;
}
export function parseTeamAppointment(payload: unknown, path: string): TeamAppointmentResponse {
  const r = teamAppointmentResponseSchema.safeParse(payload);
  if (!r.success) throw contractError('team appointment', path, r.error);
  return r.data;
}
export function parseAppointmentPatch(payload: unknown, path: string) {
  const r = appointmentPatchResponseSchema.safeParse(payload);
  if (!r.success) throw contractError('appointment patch', path, r.error);
  return r.data;
}

/**
 * Summarises a Zod failure as a short list of `"<path>: <code>"` strings so the
 * drifted field is observable in logs. Deliberately emits field PATHS and issue
 * CODES only — never the offending VALUES, which can carry lead personal data
 * (agent emails, times). Bounded so a wildly-wrong payload cannot flood a log.
 */
export function summarizeZodIssues(error: ZodError, limit = 8): string[] {
  return error.issues
    .slice(0, limit)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`);
}

function contractError(what: string, path: string, zodError?: ZodError): LeadApiError {
  return new LeadApiError('contract', `${what} response did not match the documented shape`, {
    path,
    ...(zodError === undefined ? {} : { issues: summarizeZodIssues(zodError) }),
  });
}
