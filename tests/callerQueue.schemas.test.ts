import { describe, expect, it } from 'vitest';
import {
  parseQueueResponse,
  toQueueLead,
  queueItemSchema,
} from '../src/integrations/guidedBoost/callerQueue.schemas.js';

/**
 * Boundary validation + internal conversion for the caller queue response.
 * Pure (no network/DB), so these are behaviour-level tests of the contract.
 */

// A full offer, in Guided Boost's ACTUAL shape: the identifier is `id`.
const VALID_ITEM = {
  id: 'lead-1',
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

  it('accepts the earlier `lead_id` spelling as a fallback identifier', () => {
    const { id, ...rest } = VALID_ITEM;
    void id;
    expect(parseQueueResponse([{ ...rest, lead_id: 'lead-9' }])?.leadId).toBe('lead-9');
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
    const lead = parseQueueResponse([VALID_ITEM, { ...VALID_ITEM, id: 'lead-2' }]);
    expect(lead?.leadId).toBe('lead-1');
  });

  it('a partial offer (phone / timing absent) still parses and reaches the worker', () => {
    const { phone, offered_at, call_before, ...partial } = VALID_ITEM;
    void phone;
    void offered_at;
    void call_before;
    const lead = parseQueueResponse([partial]);
    expect(lead?.leadId).toBe('lead-1');
    expect(lead?.phone).toBeUndefined();
    expect(lead?.callBeforeAt).toBeUndefined();
  });

  it('a malformed item is skipped (null), never thrown — the poller keeps running', () => {
    // No id / lead_id at all → cannot act on it, but must not stall the poll cycle.
    expect(parseQueueResponse([{ phone: '+447700900123' }])).toBeNull();
    // A present-but-bad timestamp is also skipped, not thrown.
    expect(parseQueueResponse([{ ...VALID_ITEM, call_before: 'not-a-date' }])).toBeNull();
  });
});

describe('caller queue — internal conversion', () => {
  it('stores call_before as an absolute instant (not local/time_zone derived)', () => {
    const lead = parseQueueResponse([VALID_ITEM]);
    expect(lead?.callBeforeAt).toBeInstanceOf(Date);
    expect(lead?.callBeforeAt?.toISOString()).toBe('2026-11-15T09:10:00.000Z');
    expect(lead?.offeredAt?.toISOString()).toBe('2026-11-15T09:00:00.000Z');
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

// Regression: the EXACT production response shape David observed. The previous
// schema required `lead_id`, so every real item failed validation and was thrown
// away — the queue looked empty and no lead ever reached the worker.
describe('caller queue — REGRESSION: real Guided Boost response shape', () => {
  it('recognizes a { now, leads: [ { id } ] } response as a non-empty queue', () => {
    const lead = parseQueueResponse({
      now: '2026-11-16T14:22:23Z',
      leads: [{ id: '89c17f41' }],
    });
    expect(lead).not.toBeNull();
    expect(lead?.leadId).toBe('89c17f41');
  });

  it('treats { now, leads: [] } as an empty queue (null)', () => {
    expect(
      parseQueueResponse({ now: '2026-11-16T14:22:23Z', leads: [] }),
    ).toBeNull();
  });
});
