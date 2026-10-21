import { describe, expect, it, vi } from 'vitest';
import { offerTeamSlots } from '../src/services/teamScheduling.service.js';
import type { CalendarClient } from '../src/integrations/leadApi/calendar.client.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

function fakeClient(response: unknown) {
  const getTeamSlots = vi.fn().mockResolvedValue(response);
  return { client: { getTeamSlots } as unknown as CalendarClient, getTeamSlots };
}

const slot = (t: string) => ({ starts_at: t, ends_at: t, agents: ['a@hw.com'], local: t });

describe('offerTeamSlots', () => {
  it('pool mode: offers the soonest slots (capped) and no owner name', async () => {
    const { client } = fakeClient({
      decision: { mode: 'pool', fallback: false },
      slots: [
        slot('2026-11-03T09:00:00Z'),
        slot('2026-11-03T10:00:00Z'),
        slot('2026-11-03T11:00:00Z'),
        slot('2026-11-03T12:00:00Z'),
      ],
    });
    const offer = await offerTeamSlots('lead-1', 'UTC', client, { limit: 3 });
    expect(offer.mode).toBe('pool');
    expect(offer.slots).toHaveLength(3);
    expect(offer.ownerAgentName).toBeUndefined();
  });

  it('owner mode: surfaces the owner agent name to speak', async () => {
    const { client } = fakeClient({
      decision: { mode: 'owner', fallback: false },
      owner: { email: 'sue@hw.com', name: 'Sue' },
      slots: [slot('2026-11-03T09:00:00Z')],
    });
    const offer = await offerTeamSlots('lead-1', 'UTC', client);
    expect(offer.mode).toBe('owner');
    expect(offer.ownerAgentName).toBe('Sue');
  });

  it('none mode: never offers a slot', async () => {
    const { client } = fakeClient({ decision: { mode: 'none', fallback: false }, slots: [] });
    const offer = await offerTeamSlots('lead-1', 'UTC', client);
    expect(offer.mode).toBe('none');
    expect(offer.slots).toEqual([]);
  });

  it('carries the fallback flag (owner had no slot within four days)', async () => {
    const { client } = fakeClient({
      decision: { mode: 'pool', fallback: true },
      slots: [slot('2026-11-03T09:00:00Z')],
    });
    const offer = await offerTeamSlots('lead-1', 'UTC', client);
    expect(offer.fallback).toBe(true);
  });

  it('passes the customer timezone and range through', async () => {
    const { client, getTeamSlots } = fakeClient({ decision: { mode: 'pool' }, slots: [] });
    await offerTeamSlots('lead-1', 'Australia/Sydney', client, { from: 'F', to: 'T' });
    expect(getTeamSlots).toHaveBeenCalledWith('lead-1', 'Australia/Sydney', { from: 'F', to: 'T' });
  });
});
