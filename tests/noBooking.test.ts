import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNoBooking } from '../src/services/noBooking.service.js';
import type { CalendarClient } from '../src/integrations/leadApi/calendar.client.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

function fakeClient() {
  const postLeadNote = vi.fn().mockResolvedValue(undefined);
  const forwardLead = vi.fn().mockResolvedValue(undefined);
  return {
    client: { postLeadNote, forwardLead } as unknown as CalendarClient,
    postLeadNote,
    forwardLead,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('handleNoBooking', () => {
  it('no_answer: leaves NO note and does not forward', async () => {
    const { client, postLeadNote, forwardLead } = fakeClient();
    const r = await handleNoBooking({ leadId: 'lead-1', reason: 'no_answer' }, { client });
    expect(r.action).toBe('none');
    expect(postLeadNote).not.toHaveBeenCalled();
    expect(forwardLead).not.toHaveBeenCalled();
  });

  it('wants_later: posts exactly one note, no forward', async () => {
    const { client, postLeadNote, forwardLead } = fakeClient();
    const r = await handleNoBooking(
      {
        leadId: 'lead-1',
        reason: 'wants_later',
        note: 'Call back next week; party of 2',
        noteStatus: 'Callback',
      },
      { client },
    );
    expect(r.action).toBe('noted');
    expect(postLeadNote).toHaveBeenCalledTimes(1);
    expect(postLeadNote).toHaveBeenCalledWith(
      'lead-1',
      expect.objectContaining({ note: expect.stringContaining('next week') }),
    );
    expect(forwardLead).not.toHaveBeenCalled();
  });

  it('declined with forwardNow: posts the note AND forwards to legacy now', async () => {
    const { client, postLeadNote, forwardLead } = fakeClient();
    const r = await handleNoBooking(
      { leadId: 'lead-1', reason: 'declined', note: 'Not interested', forwardNow: true },
      { client },
    );
    expect(r.action).toBe('noted_and_forwarded');
    expect(postLeadNote).toHaveBeenCalledTimes(1);
    expect(forwardLead).toHaveBeenCalledTimes(1);
  });

  it('declined without forwardNow: just the note (timer forwards)', async () => {
    const { client, forwardLead } = fakeClient();
    const r = await handleNoBooking(
      { leadId: 'lead-1', reason: 'declined', note: 'Not interested' },
      { client },
    );
    expect(r.action).toBe('noted');
    expect(forwardLead).not.toHaveBeenCalled();
  });
});
