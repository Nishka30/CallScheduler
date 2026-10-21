import type { LeadListRow } from '../integrations/leadApi/schemas.js';

/**
 * The Oct 20 brief's hard "call this lead?" gate, over the live lead fields.
 * Independent of the eligibility/newness logic in `leadEligibility.service.ts`
 * and of the hold-timing check in `callWindow.service.ts`: this covers the new
 * routing/ownership fields a lead must satisfy to be called at all.
 *
 * A lead is callable only when: a phone is present, it is not deleted, it has no
 * sales agent yet, no call is already booked, and `crm_route` is null (the hold
 * is still running). `crm_route` of `legacy` (already forwarded) or `crm` (a
 * call is already booked) is never called.
 *
 * NOTE: `crm_route` null is necessary but NOT sufficient — the active-hold
 * (future `caller_hold_until`) check is applied separately by the caller, per
 * the brief ("do not assume crm_route=null alone proves an active hold").
 */
export type CrmGateReason =
  | 'ok'
  | 'phone_absent'
  | 'lead_deleted'
  | 'already_assigned'
  | 'already_booked'
  | 'crm_route_excluded';

export interface CrmGateResult {
  ok: boolean;
  reason: CrmGateReason;
  detail?: string;
}

export function evaluateCrmGate(row: LeadListRow): CrmGateResult {
  const r = row as unknown as Record<string, unknown>;

  const phone = r['phone'];
  if (phone === null || phone === undefined || phone === '') {
    return { ok: false, reason: 'phone_absent' };
  }

  if (row.is_deleted === true) {
    return { ok: false, reason: 'lead_deleted' };
  }

  const agent = r['sales_agent_email'];
  if (agent !== null && agent !== undefined && agent !== '') {
    return { ok: false, reason: 'already_assigned' };
  }

  const booked = r['booked_call'];
  if (booked !== null && booked !== undefined) {
    return { ok: false, reason: 'already_booked' };
  }

  const route = r['crm_route'];
  if (route === 'legacy' || route === 'crm') {
    return { ok: false, reason: 'crm_route_excluded', detail: `crm_route=${route}` };
  }

  return { ok: true, reason: 'ok' };
}
