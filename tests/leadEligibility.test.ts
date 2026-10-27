import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import {
  evaluateListEligibility,
  evaluatePhoneEligibility,
  readPhoneVerdict,
} from '../src/services/leadEligibility.service.js';
import type { LeadListRow } from '../src/integrations/leadApi/schemas.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

const NOW = new Date('2026-10-14T12:00:00.000Z');

function config(overrides: Record<string, string> = {}) {
  return parseEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    // Default-off in production; most tests opt in to exercise the rules past it.
    LEAD_ELIGIBILITY_AUTO_ENABLED: 'true',
    ...overrides,
  });
}

/** A row that passes every verified check, 10 minutes old. */
function freshRow(overrides: Record<string, unknown> = {}): LeadListRow {
  return {
    id: 'lead-1',
    updated_at: '2026-10-14T11:55:00.000Z',
    created_at: '2026-10-14T11:50:00.000Z',
    person_key: 'lead:lead-1',
    is_deleted: false,
    is_lead: true,
    lead_status: 'New Lead',
    ...overrides,
  };
}

function evaluate(row: LeadListRow, overrides: Record<string, string> = {}, bootstrap = false) {
  return evaluateListEligibility({
    row,
    now: NOW,
    isBootstrapRun: bootstrap,
    config: config(overrides),
  });
}

describe('new vs changed leads', () => {
  it('accepts a genuinely new inquiry', () => {
    expect(evaluate(freshRow())).toEqual({ outcome: 'ELIGIBLE', reason: 'eligible' });
  });

  it('does not reject a lead for being old - duplicate prevention is structural, not an age cutoff', () => {
    // A fixed age window was tried and removed: a poller that fell behind
    // schedule would wrongly skip a genuinely new, never-before-seen lead
    // once it crossed the cutoff. The real guard against re-processing an
    // old, merely-updated lead is that `recordLeadDecision` only ever
    // transitions a lead out of PENDING once (see
    // leadPolling.test.ts > "does not re-decide a lead on a later polling
    // cycle") - this pure function has no notion of "already decided" and
    // must not invent one via a timestamp comparison.
    const row = freshRow({
      created_at: '2026-09-14T11:50:00.000Z',
      updated_at: '2026-10-14T11:59:00.000Z',
    });

    expect(evaluate(row)).toEqual({ outcome: 'ELIGIBLE', reason: 'eligible' });
  });

  it('refuses to decide when no creation timestamp exists', () => {
    const row = freshRow();
    delete (row as Record<string, unknown>)['created_at'];

    const decision = evaluate(row);

    // This is the unresolved contract detail; it must never become ELIGIBLE.
    expect(decision.outcome).toBe('NEEDS_REVIEW');
    expect(decision.reason).toBe('created_at_field_absent');
  });

  it('refuses to decide when the creation timestamp is unparsable', () => {
    expect(evaluate(freshRow({ created_at: 'not-a-date' })).reason).toBe('created_at_field_absent');
  });

  it('treats a null creation timestamp as undecidable', () => {
    expect(evaluate(freshRow({ created_at: null })).outcome).toBe('NEEDS_REVIEW');
  });
});

describe('the master safety switch', () => {
  it('holds an otherwise-eligible lead for review while auto-eligibility is off', () => {
    const decision = evaluate(freshRow(), { LEAD_ELIGIBILITY_AUTO_ENABLED: 'false' });

    expect(decision.outcome).toBe('NEEDS_REVIEW');
    expect(decision.reason).toBe('awaiting_new_lead_rule_confirmation');
  });

  it('is off by default, so a default deployment can never auto-call', () => {
    const defaults = parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });

    expect(defaults.LEAD_ELIGIBILITY_AUTO_ENABLED).toBe(false);
    expect(
      evaluateListEligibility({ row: freshRow(), now: NOW, config: defaults }).outcome,
    ).not.toBe('ELIGIBLE');
  });

  it('still skips clearly ineligible leads while the switch is off', () => {
    // The switch withholds approval; it does not suppress real skip reasons.
    const decision = evaluate(freshRow({ is_deleted: true }), {
      LEAD_ELIGIBILITY_AUTO_ENABLED: 'false',
    });

    expect(decision).toEqual({ outcome: 'SKIPPED', reason: 'lead_deleted' });
  });
});

describe('bootstrap protection', () => {
  it('never treats a lead seen during the first poll as new', () => {
    const decision = evaluate(freshRow(), {}, true);

    expect(decision).toEqual({ outcome: 'SKIPPED', reason: 'known_before_bootstrap' });
  });

  it('applies bootstrap protection even to a brand-new-looking lead', () => {
    const row = freshRow({ created_at: NOW.toISOString() });

    expect(evaluate(row, {}, true).reason).toBe('known_before_bootstrap');
  });
});

describe('contact eligibility', () => {
  it('skips a deleted lead', () => {
    expect(evaluate(freshRow({ is_deleted: true }))).toEqual({
      outcome: 'SKIPPED',
      reason: 'lead_deleted',
    });
  });

  it('skips a record that is not a lead', () => {
    expect(evaluate(freshRow({ is_lead: false })).reason).toBe('not_a_lead');
  });

  it('skips a record whose is_lead is null (a visit or unvalidated number)', () => {
    expect(evaluate(freshRow({ is_lead: null })).reason).toBe('not_a_lead');
  });

  it('refuses to decide when is_lead is absent', () => {
    const row = freshRow();
    delete (row as Record<string, unknown>)['is_lead'];

    expect(evaluate(row)).toMatchObject({
      outcome: 'NEEDS_REVIEW',
      reason: 'is_lead_field_absent',
    });
  });

  it.each(['Unsubscribe', 'Post Trip', 'Closed'])('skips a lead with status %s', (status) => {
    // Exactly the three statuses the workflow documentation names. Other
    // observed statuses (Unsubscribe (M), Deleted, Newsletter, Cancelled (NR),
    // Dead Lead) are deliberately NOT blocked by default - see the next test.
    const decision = evaluate(freshRow({ lead_status: status }));

    expect(decision.outcome).toBe('SKIPPED');
    expect(decision.reason).toBe('status_blocked');
  });

  it.each(['Unsubscribe (M)', 'Deleted', 'Newsletter', 'Cancelled (NR)', 'Dead Lead'])(
    'does NOT block status %s by default - not one of the three documented exclusions',
    (status) => {
      // Confirming these are left alone is as important as confirming the
      // three documented ones are blocked: adding them would be inventing a
      // business rule the workflow documentation never stated.
      expect(evaluate(freshRow({ lead_status: status })).outcome).toBe('ELIGIBLE');
    },
  );

  it('matches blocked statuses regardless of case and padding', () => {
    expect(evaluate(freshRow({ lead_status: '  unsubscribe  ' })).reason).toBe('status_blocked');
  });

  it('honours a configured blocklist', () => {
    const decision = evaluate(freshRow({ lead_status: 'Booked' }), {
      LEAD_BLOCKED_STATUSES: 'Booked,Refunded',
    });

    expect(decision.reason).toBe('status_blocked');
  });

  it('allows a null lead_status, which is the common live case', () => {
    // 2293 of 2400 sampled rows had lead_status null - no status set yet.
    expect(evaluate(freshRow({ lead_status: null })).outcome).toBe('ELIGIBLE');
  });

  it('refuses to decide when lead_status is absent', () => {
    const row = freshRow();
    delete (row as Record<string, unknown>)['lead_status'];

    expect(evaluate(row).reason).toBe('lead_status_field_absent');
  });

  it('checks deletion before anything else', () => {
    // A deleted row missing every other field is still a clean skip.
    const row = {
      id: 'x',
      updated_at: '2026-10-14T11:00:00.000Z',
      is_deleted: true,
    } as LeadListRow;

    expect(evaluate(row).reason).toBe('lead_deleted');
  });

  it('blocks an Unsubscribed lead via the status check alone, even with a fully validated phone', () => {
    // Regression for lead 5528514a-3442-4741-aff3-2d54ba1ac668: the CRM later
    // tagged this lead `lead_status: "Unsubscribe"`, and its phone verdict was
    // (separately, and later) confirmed valid. evaluateListEligibility must stop
    // at the status check and never need, or be influenced by, the phone step -
    // the opt-out block is architecturally independent of phone validity, since
    // the phone step (resolveWithContext) is only ever reached when list
    // eligibility is ELIGIBLE in the first place.
    const decision = evaluate(freshRow({ lead_status: 'Unsubscribe' }));
    expect(decision).toEqual({
      outcome: 'SKIPPED',
      reason: 'status_blocked',
      detail: 'status "Unsubscribe"',
    });
  });
});

describe('caller holds', () => {
  // The hold reserves a lead FOR the AI Caller against human CRM claiming
  // (confirmed by the workflow documentation) - it is a reason to call soon,
  // never a reason to skip. `evaluateListEligibility` does not gate on
  // `caller_hold_until` at all; the value is surfaced to the call context
  // instead (see leadContext.test.ts).

  it('does not skip a lead with an active (future) caller hold', () => {
    const decision = evaluate(freshRow({ caller_hold_until: '2026-10-14T18:00:00.000Z' }));

    expect(decision).toEqual({ outcome: 'ELIGIBLE', reason: 'eligible' });
  });

  it('does not skip a lead whose hold has already expired', () => {
    expect(evaluate(freshRow({ caller_hold_until: '2026-10-14T06:00:00.000Z' })).outcome).toBe(
      'ELIGIBLE',
    );
  });

  it('treats a null hold as no hold', () => {
    expect(evaluate(freshRow({ caller_hold_until: null })).outcome).toBe('ELIGIBLE');
  });

  it('does not reject a lead for an unparsable hold value either', () => {
    // We never act on this field here, so a malformed value cannot block
    // anything - it simply will not appear in the call context (see
    // leadContext.test.ts).
    expect(evaluate(freshRow({ caller_hold_until: 'soon' })).outcome).toBe('ELIGIBLE');
  });
});

describe('phone verdict', () => {
  /** The confirmed live shape of a validated number. */
  const validVerdict = {
    phone_raw: '07700900123',
    phone_e164: '+447700900123',
    phone_best: '+447700900123',
    valid: true,
    tier: 'live_mobile',
    line_type: 'mobile',
    country_iso: 'GB',
    lookup_status: 'ok',
  };

  it('accepts the confirmed validated shape', () => {
    expect(readPhoneVerdict(validVerdict)).toEqual({
      status: 'valid',
      e164: '+447700900123',
      tier: 'live_mobile',
      lineType: 'mobile',
    });
  });

  it('rejects the confirmed "never validated" shape', () => {
    // Live data: an unvalidated number has valid null and tier none.
    const verdict = readPhoneVerdict({
      phone_raw: '07700900123',
      phone_e164: null,
      valid: null,
      tier: 'none',
    });

    expect(verdict.status).toBe('invalid');
    expect(verdict).toMatchObject({ detail: expect.stringContaining('not validated') as string });
  });

  it('never falls back to phone_raw or phone_best', () => {
    const verdict = readPhoneVerdict({
      phone_raw: '07700900123',
      phone_best: '+447700900123',
      phone_e164: null,
      valid: null,
    });

    expect(verdict.status).toBe('invalid');
    expect(JSON.stringify(verdict)).not.toContain('447700900123');
  });

  it('rejects a number explicitly marked invalid', () => {
    expect(readPhoneVerdict({ ...validVerdict, valid: false }).status).toBe('invalid');
  });

  it('rejects valid=true with a malformed E.164 value', () => {
    expect(readPhoneVerdict({ ...validVerdict, phone_e164: '0770-0900' }).status).toBe('invalid');
  });

  it('rejects a lookup that did not complete cleanly', () => {
    const verdict = readPhoneVerdict({ ...validVerdict, lookup_status: 'failed' });

    expect(verdict).toMatchObject({ status: 'invalid' });
  });

  it('reports an unrecognised shape as unreadable, with key names only', () => {
    const verdict = readPhoneVerdict({ number: '+447700900123', verdict: 'ok' });

    expect(verdict.status).toBe('unreadable');
    expect(verdict).toMatchObject({ observedKeys: ['number', 'verdict'] });
    expect(JSON.stringify(verdict)).not.toContain('447700900123');
  });

  it('treats a missing phone verdict as unreadable rather than valid', () => {
    expect(readPhoneVerdict(undefined).status).toBe('unreadable');
    expect(readPhoneVerdict(null).status).toBe('unreadable');
    expect(readPhoneVerdict('+447700900123').status).toBe('unreadable');
  });

  it('reproduces the exact stored detail message for an absent phone object', () => {
    // This is the literal message recorded for lead
    // 5528514a-3442-4741-aff3-2d54ba1ac668 as `phone_verdict_unreadable`. The
    // Lead API's phone-verification object had not been created yet at the
    // moment of that evaluation (confirmed: it existed and was fully valid by
    // the time this was investigated, ~9 minutes after the lead's created_at,
    // matching the known ~7-10 minute async validation delay).
    const decision = evaluatePhoneEligibility({ phone: null });
    expect(decision).toEqual({
      outcome: 'NEEDS_REVIEW',
      reason: 'phone_verdict_unreadable',
      detail: 'phone verdict was absent or not an object',
    });
  });

  it('accepts the exact confirmed shape from lead 5528514a (India, WhatsApp-derived mobile)', () => {
    const laterConfirmedShape = {
      phone_raw: '+916291764011',
      phone_e164: '+916291764011',
      phone_best: '+916291764011',
      valid: true,
      tier: 'live_mobile',
      line_type: 'mobile',
      country_iso: 'IN',
      lookup_status: 'ok',
    };
    expect(readPhoneVerdict(laterConfirmedShape)).toEqual({
      status: 'valid',
      e164: '+916291764011',
      tier: 'live_mobile',
      lineType: 'mobile',
    });
    expect(evaluatePhoneEligibility({ phone: laterConfirmedShape }).outcome).toBe('ELIGIBLE');
  });

  it('routes an unreadable verdict to review, never to a call', () => {
    const decision = evaluatePhoneEligibility({ phone: { number: '+44770' } });

    expect(decision.outcome).toBe('NEEDS_REVIEW');
    expect(decision.reason).toBe('phone_verdict_unreadable');
    expect(decision.detail).not.toContain('44770');
  });

  it('skips a lead whose number failed validation', () => {
    const decision = evaluatePhoneEligibility({
      phone: { phone_e164: null, valid: null, tier: 'none' },
    });

    expect(decision).toMatchObject({ outcome: 'SKIPPED', reason: 'phone_not_validated' });
  });

  it('passes a lead with a validated number', () => {
    expect(evaluatePhoneEligibility({ phone: validVerdict }).outcome).toBe('ELIGIBLE');
  });
});
