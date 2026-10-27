import type { CalendarClient } from '../integrations/leadApi/calendar.client.js';

/**
 * Reads pooled/owner availability from the team-slots endpoint and turns it into
 * a short offer the caller can speak. All routing (owner-first, rotation,
 * fallback) is decided server-side; this service only reads `decision.mode` and
 * the returned slots — it never picks an agent.
 */

export interface OfferedSlot {
  /** UTC instant to book with (`starts_at`). */
  startsAt: string;
  endsAt?: string;
  /** Readable time in the customer's zone, for speaking only. */
  local?: string;
  /** Agent emails eligible for this slot (informational; rotation decides). */
  agents?: string[];
}

export interface SlotOffer {
  /** `owner` | `pool` | `none` from the API. */
  mode: string;
  /** True when an owner existed but had no slot within four days (David is emailed). */
  fallback: boolean;
  /** In owner mode, the agent whose times these are, to name to the customer. */
  ownerAgentName?: string;
  /** Up to `limit` soonest slots; empty in `none` mode or when nobody is free. */
  slots: OfferedSlot[];
}

export async function offerTeamSlots(
  leadId: string,
  customerTz: string,
  client: CalendarClient,
  options: { limit?: number; from?: string; to?: string } = {},
): Promise<SlotOffer> {
  const limit = options.limit ?? 3;
  const res = await client.getTeamSlots(leadId, customerTz, {
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });

  const mode = res.decision.mode;
  const fallback = res.decision.fallback === true;

  // `none` means nobody takes the brand's bookings: never offer a slot.
  const slots: OfferedSlot[] =
    mode === 'none'
      ? []
      : res.slots.slice(0, limit).map((s) => {
          const slot: OfferedSlot = { startsAt: s.starts_at };
          const endsAt = s.ends_at ?? undefined;
          if (endsAt !== undefined) slot.endsAt = endsAt;
          const local = s.local ?? undefined;
          if (local !== undefined) slot.local = local;
          const agents = s.agents ?? undefined;
          if (agents !== undefined) slot.agents = agents;
          return slot;
        });

  // In owner mode the owner's name is read back to the customer. The full agent
  // object is the top-level `owner`; `decision.owner` is only the owner's email
  // string, so the name comes from `owner` (then the agents list as a fallback).
  const ownerAgentName =
    mode === 'owner' ? (res.owner?.name ?? res.agents?.[0]?.name ?? undefined) : undefined;

  return {
    mode,
    fallback,
    ...(ownerAgentName === undefined ? {} : { ownerAgentName }),
    slots,
  };
}
