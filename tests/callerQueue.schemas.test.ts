import { describe, expect, it } from 'vitest';
import { LeadApiError } from '../src/integrations/leadApi/errors.js';
import {
  parseQueueResponse,
  toQueueLead,
  queueItemSchema,
} from '../src/integrations/guidedBoost/callerQueue.schemas.js';

/**
 * Boundary validation + internal conversion for the caller queue response.
 * Pure (no network/DB), so these are behaviour-level tests of the contract.
 */

const VALID_ITEM = {
  lead_id: 'lead-1',
  phone: '+447700900123',
  name: 'John Smyth',
  email: 'john@example.com',
  brand: 'himalayan',
  page_slug: 'everest-base-camp',
  answers: [{ questionId: 'confirm_trek', prompt: 'Which trek?', answer: 'EBC' }],
  summary: 'Keen trekker, flexible dates.',
  time_zone: 'Europe/London',
  offered_at: '2026-11-15T09:00:00.000Z',
  call_before: '2026-11-15T09:10:00.000Z',
  is_test: false,
};

describe('caller queue — response validation', () => {
  it('parses a bare-array response with one item', () => {
    const lead = parseQueueResponse([VALID_ITEM]);
    expect(lead?.leadId).toBe('lead-1');
    expect(lead?.phone).toBe('+447700900123');
  });

  it('parses a { leads: [...] } wrapper', () => {
    expect(parseQueueResponse({ leads: [VALID_ITEM] })?.leadId).toBe('lead-1');
  });

  it('parses a single bare item object', () => {
    expect(parseQueueResponse(VALID_ITEM)?.leadId).toBe('lead-1');
  });

  it('returns null for an empty queue (empty array)', () => {
    expect(parseQueueResponse([])).toBeNull();
  });

  it('returns null for an empty queue ({ leads: [] } and null)', () => {
    expect(parseQueueResponse({ leads: [] })).toBeNull();
    expect(parseQueueResponse(null)).toBeNull();
    expect(parseQueueResponse({ lead: null })).toBeNull();
  });

  it('uses the first item when more than one is (unexpectedly) returned', () => {
    const lead = parseQueueResponse([VALID_ITEM, { ...VALID_ITEM, lead_id: 'lead-2' }]);
    expect(lead?.leadId).toBe('lead-1');
  });

  it('rejects a malformed item (wrong types)', () => {
    expect(() => parseQueueResponse([{ ...VALID_ITEM, lead_id: 123 }])).toThrow(LeadApiError);
  });

  it('rejects an item missing a required field (phone)', () => {
    const { phone, ...noPhone } = VALID_ITEM;
    void phone;
    expect(() => parseQueueResponse([noPhone])).toThrow(LeadApiError);
  });

  it('rejects an item missing the authoritative deadline (call_before)', () => {
    const { call_before, ...noDeadline } = VALID_ITEM;
    void call_before;
    expect(() => parseQueueResponse([noDeadline])).toThrow(LeadApiError);
  });

  it('rejects a non-parseable call_before timestamp', () => {
    expect(() => parseQueueResponse([{ ...VALID_ITEM, call_before: 'not-a-date' }])).toThrow(
      LeadApiError,
    );
  });
});

describe('caller queue — internal conversion', () => {
  it('stores call_before as an absolute instant (not local/time_zone derived)', () => {
    const lead = parseQueueResponse([VALID_ITEM]);
    expect(lead?.callBeforeAt).toBeInstanceOf(Date);
    expect(lead?.callBeforeAt.toISOString()).toBe('2026-11-15T09:10:00.000Z');
    expect(lead?.offeredAt.toISOString()).toBe('2026-11-15T09:00:00.000Z');
  });

  it('flows is_test through without special-casing', () => {
    expect(parseQueueResponse([{ ...VALID_ITEM, is_test: true }])?.isTest).toBe(true);
    expect(parseQueueResponse([VALID_ITEM])?.isTest).toBe(false);
  });

  it('converts external snake_case to internal camelCase', () => {
    const lead = toQueueLead(queueItemSchema.parse(VALID_ITEM));
    expect(lead.pageSlug).toBe('everest-base-camp');
    expect(lead.timeZone).toBe('Europe/London');
  });
});

describe('caller queue — answers adapter', () => {
  it('keeps valid answers in the internal representation', () => {
    const lead = parseQueueResponse([VALID_ITEM]);
    expect(lead?.answers).toEqual([
      { questionId: 'confirm_trek', prompt: 'Which trek?', answer: 'EBC' },
    ]);
  });

  it('yields [] when answers is absent (no fabricated context)', () => {
    const { answers, ...noAnswers } = VALID_ITEM;
    void answers;
    expect(parseQueueResponse([noAnswers])?.answers).toEqual([]);
  });

  it('drops malformed answer entries rather than guessing', () => {
    const lead = parseQueueResponse([
      { ...VALID_ITEM, answers: [{ questionId: 'confirm_trek' }, { prompt: 'x', answer: 'y' }] },
    ]);
    expect(lead?.answers).toEqual([]);
  });

  it('keeps unknown/unneeded answer IDs (mapping simply ignores them later)', () => {
    const lead = parseQueueResponse([
      {
        ...VALID_ITEM,
        answers: [{ questionId: 'unknown_id', prompt: 'Anything?', answer: 'Sure' }],
      },
    ]);
    expect(lead?.answers).toEqual([
      { questionId: 'unknown_id', prompt: 'Anything?', answer: 'Sure' },
    ]);
  });
});
