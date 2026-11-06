import { describe, expect, it, vi } from 'vitest';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import {
  notifyNeedsReviewToCrm,
  NEEDS_REVIEW_NOTIFY_REASONS,
} from '../src/services/needsReviewNotification.service.js';

function fakeClient(postLeadNote = vi.fn().mockResolvedValue(undefined)) {
  return { postLeadNote };
}

describe('notifyNeedsReviewToCrm', () => {
  it('posts a CRM lead note carrying the REAL reason code (not a generic message)', async () => {
    const client = fakeClient();

    const result = await notifyNeedsReviewToCrm(
      'lead-1',
      'phone_verdict_unreadable',
      'phone verdict keys: number',
      { client },
    );

    expect(result).toBe('sent');
    expect(client.postLeadNote).toHaveBeenCalledTimes(1);
    const [leadId, input] = client.postLeadNote.mock.calls[0]!;
    expect(leadId).toBe('lead-1');
    // The real reason code must be present; it must NOT be a bare "Needs review".
    expect(input.note).toContain('phone_verdict_unreadable');
    expect(input.note.toLowerCase()).not.toBe('needs review');
    // A human explanation is included too.
    expect(input.note.length).toBeGreaterThan('phone_verdict_unreadable'.length + 5);
  });

  it('includes the supplied detail in the note when present', async () => {
    const client = fakeClient();
    await notifyNeedsReviewToCrm('lead-1', 'context_lookup_failed', 'person history 404', {
      client,
    });
    expect(client.postLeadNote.mock.calls[0]![1].note).toContain('person history 404');
  });

  it('does NOT notify the CRM for awaiting_new_lead_rule_confirmation (a config state, not a lead problem)', async () => {
    const client = fakeClient();

    const result = await notifyNeedsReviewToCrm(
      'lead-1',
      'awaiting_new_lead_rule_confirmation',
      undefined,
      { client },
    );

    expect(result).toBe('skipped');
    expect(client.postLeadNote).not.toHaveBeenCalled();
  });

  it('returns failed and never throws when the CRM write fails', async () => {
    const client = fakeClient(
      vi.fn().mockRejectedValue(new LeadApiError('server', 'down', { path: '/x', status: 503 })),
    );

    const result = await notifyNeedsReviewToCrm('lead-1', 'person_key_absent', undefined, {
      client,
    });

    expect(result).toBe('failed'); // decision stays NEEDS_REVIEW internally; caller never sees a throw
  });

  it('exposes the notify allow-list and excludes the config reason', () => {
    expect(NEEDS_REVIEW_NOTIFY_REASONS).toContain('phone_verdict_unreadable');
    expect(NEEDS_REVIEW_NOTIFY_REASONS).not.toContain('awaiting_new_lead_rule_confirmation');
  });

  it('notifies the CRM for a retry that gave up waiting for a caller hold', async () => {
    const client = fakeClient();

    const result = await notifyNeedsReviewToCrm(
      'lead-1',
      'retry_hold_unavailable',
      'no valid caller hold within 24h',
      { client },
    );

    expect(result).toBe('sent');
    expect(NEEDS_REVIEW_NOTIFY_REASONS).toContain('retry_hold_unavailable');
    expect(client.postLeadNote.mock.calls[0]![1].note).toContain('retry_hold_unavailable');
  });

  it('notifies the CRM for a stuck-call reconciliation (call_unreconciled)', async () => {
    const client = fakeClient();
    const result = await notifyNeedsReviewToCrm('lead-1', 'call_unreconciled', undefined, { client });
    expect(result).toBe('sent');
    expect(NEEDS_REVIEW_NOTIFY_REASONS).toContain('call_unreconciled');
    expect(client.postLeadNote.mock.calls[0]![1].note).toContain('call_unreconciled');
  });
});
