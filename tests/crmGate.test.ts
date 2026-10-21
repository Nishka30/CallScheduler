import { describe, expect, it, vi } from 'vitest';
import { evaluateCrmGate } from '../src/services/crmGate.service.js';
import type { LeadListRow } from '../src/integrations/leadApi/schemas.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

function row(overrides: Record<string, unknown> = {}): LeadListRow {
  const base: Record<string, unknown> = {
    id: 'lead-1',
    updated_at: '2026-10-20T00:00:00Z',
    phone: '+447700900123',
    is_deleted: false,
    sales_agent_email: null,
    booked_call: null,
    crm_route: null,
    ...overrides,
  };
  return base as unknown as LeadListRow;
}

describe('evaluateCrmGate', () => {
  it('passes a callable lead (phone, not deleted, unassigned, unbooked, crm_route null)', () => {
    expect(evaluateCrmGate(row())).toEqual({ ok: true, reason: 'ok' });
  });

  it('rejects a lead with no phone', () => {
    expect(evaluateCrmGate(row({ phone: null })).reason).toBe('phone_absent');
    expect(evaluateCrmGate(row({ phone: '' })).reason).toBe('phone_absent');
  });

  it('rejects a deleted lead', () => {
    expect(evaluateCrmGate(row({ is_deleted: true })).reason).toBe('lead_deleted');
  });

  it('rejects an already-assigned lead (sales_agent_email set)', () => {
    expect(evaluateCrmGate(row({ sales_agent_email: 'sue@hw.com' })).reason).toBe(
      'already_assigned',
    );
  });

  it('rejects a lead that already has a booked call', () => {
    expect(evaluateCrmGate(row({ booked_call: 'appt_1' })).reason).toBe('already_booked');
  });

  it('never calls crm_route legacy or crm', () => {
    expect(evaluateCrmGate(row({ crm_route: 'legacy' })).reason).toBe('crm_route_excluded');
    expect(evaluateCrmGate(row({ crm_route: 'crm' })).reason).toBe('crm_route_excluded');
  });
});
