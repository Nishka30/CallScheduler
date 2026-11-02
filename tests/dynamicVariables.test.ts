import { describe, expect, it, vi } from 'vitest';
import { buildAgentDynamicVariables } from '../src/integrations/retell/dynamicVariables.js';
import type { LeadCallContext } from '../src/services/leadContext.service.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

function context(overrides: Partial<LeadCallContext> = {}): LeadCallContext {
  return { leadId: 'lead-1', answers: [], leadFields: {}, ...overrides };
}

describe('buildAgentDynamicVariables', () => {
  it('maps customer_name and brand_name from the lead context', () => {
    expect(
      buildAgentDynamicVariables(context({ customerName: 'John Smyth', brand: 'himalayan' })),
    ).toEqual({ customer_name: 'John Smyth', brand_name: 'himalayan' });
  });

  it('uses the exact Retell variable names without braces', () => {
    const vars = buildAgentDynamicVariables(context({ customerName: 'A', brand: 'B' }));
    expect(Object.keys(vars).sort()).toEqual(['brand_name', 'customer_name']);
  });

  it('omits a missing customer name rather than inventing one', () => {
    expect(buildAgentDynamicVariables(context({ brand: 'himalayan' }))).toEqual({
      brand_name: 'himalayan',
    });
  });

  it('omits a missing brand', () => {
    expect(buildAgentDynamicVariables(context({ customerName: 'John' }))).toEqual({
      customer_name: 'John',
    });
  });

  it('returns an empty object when neither value is available', () => {
    expect(buildAgentDynamicVariables(context())).toEqual({});
  });

  it('trims surrounding whitespace and treats blank values as absent', () => {
    expect(buildAgentDynamicVariables(context({ customerName: '  John  ', brand: '   ' }))).toEqual(
      {
        customer_name: 'John',
      },
    );
  });

  it('maps the full destination-aware trip context into snake_case variables', () => {
    const vars = buildAgentDynamicVariables(
      context({
        customerName: 'Nishka',
        brand: 'himalayanwonders.com',
        enquiredDestination: 'Nepal',
        trek: 'Everest region',
        tripLength: '5–7 days',
        groupSize: 'Individual',
        experience: 'A few short hikes',
        timing: '2026',
        specificRequirements: 'I want a trip for 4 days',
      }),
    );
    expect(vars).toEqual({
      customer_name: 'Nishka',
      brand_name: 'himalayanwonders.com',
      enquired_destination: 'Nepal',
      preferred_trek: 'Everest region',
      trip_duration: '5–7 days',
      group_size: 'Individual',
      travel_experience: 'A few short hikes',
      travel_timing: '2026',
      special_requirements: 'I want a trip for 4 days',
    });
  });

  it('omits each trip variable independently when its value is missing', () => {
    // A Nepal enquiry that only answered destination + trek: nothing else invented.
    const vars = buildAgentDynamicVariables(
      context({ customerName: 'Nishka', enquiredDestination: 'Nepal', trek: 'Everest region' }),
    );
    expect(vars).toEqual({
      customer_name: 'Nishka',
      enquired_destination: 'Nepal',
      preferred_trek: 'Everest region',
    });
  });

  it('drops blank or whitespace-only trip answers rather than sending them', () => {
    const vars = buildAgentDynamicVariables(
      context({ enquiredDestination: 'Nepal', trek: '   ', tripLength: '', groupSize: '2' }),
    );
    expect(vars).toEqual({ enquired_destination: 'Nepal', group_size: '2' });
  });

  // A fixed instant so customer_local_time is deterministic: 12:30 PM in Denver.
  const NOW = new Date('2026-11-05T19:30:00.000Z');

  it('adds timezone, label, source=browser and a dynamic local time from a valid CRM timezone', () => {
    const vars = buildAgentDynamicVariables(
      context({ customerName: 'Jo', customerTz: 'America/Denver' }),
      { now: NOW },
    );
    expect(vars).toEqual({
      customer_name: 'Jo',
      customer_timezone: 'America/Denver',
      customer_timezone_label: 'Mountain Time',
      customer_timezone_source: 'browser',
      customer_local_time: '12:30 PM',
    });
  });

  it('normalizes a non-IANA CRM timezone spelling before sending it', () => {
    // Defence in depth: the CRM should send IANA, but we still normalize.
    const vars = buildAgentDynamicVariables(context({ customerTz: 'India Standard Time' }), {
      now: NOW,
    });
    expect(vars).toMatchObject({
      customer_timezone: 'Asia/Kolkata',
      customer_timezone_label: 'India Standard Time',
      customer_timezone_source: 'browser',
      customer_local_time: '1:00 AM',
    });
  });

  it('PRIORITY: a valid browser timezone wins over a phone-derived one', () => {
    const vars = buildAgentDynamicVariables(
      context({ customerTz: 'America/Denver', phoneCountryIso: 'IN' }),
      { now: NOW },
    );
    expect(vars.customer_timezone).toBe('America/Denver');
    expect(vars.customer_timezone_source).toBe('browser');
  });

  it('FALLBACK: a missing browser timezone uses a reliable phone-derived zone', () => {
    const vars = buildAgentDynamicVariables(context({ phoneCountryIso: 'IN' }), { now: NOW });
    expect(vars).toMatchObject({
      customer_timezone: 'Asia/Calcutta',
      customer_timezone_label: 'India Standard Time',
      customer_timezone_source: 'phone',
    });
    expect(vars.customer_local_time).toBeDefined();
  });

  it('FALLBACK: an invalid browser timezone falls back to phone detection', () => {
    const vars = buildAgentDynamicVariables(
      context({ customerTz: 'not-a-zone', phoneCountryIso: 'GB' }),
      { now: NOW },
    );
    expect(vars.customer_timezone).toBe('Europe/London');
    expect(vars.customer_timezone_source).toBe('phone');
  });

  it('AMBIGUOUS: a multi-timezone phone country produces no suggestion', () => {
    const vars = buildAgentDynamicVariables(context({ phoneCountryIso: 'US' }), { now: NOW });
    expect(vars).not.toHaveProperty('customer_timezone');
    expect(vars).not.toHaveProperty('customer_timezone_source');
  });

  it('omits everything when the browser timezone is missing and there is no phone country', () => {
    const vars = buildAgentDynamicVariables(context({ customerName: 'Jo' }), { now: NOW });
    expect(vars).toEqual({ customer_name: 'Jo' });
    expect(vars).not.toHaveProperty('customer_timezone');
    expect(vars).not.toHaveProperty('customer_timezone_label');
    expect(vars).not.toHaveProperty('customer_timezone_source');
    expect(vars).not.toHaveProperty('customer_local_time');
  });

  it('omits everything for an invalid browser timezone with no usable phone country', () => {
    for (const bad of ['not-a-timezone', '   ', 'Mars/Phobos']) {
      const vars = buildAgentDynamicVariables(context({ customerTz: bad }), { now: NOW });
      expect(vars).not.toHaveProperty('customer_timezone');
      expect(vars).not.toHaveProperty('customer_timezone_label');
      expect(vars).not.toHaveProperty('customer_timezone_source');
      const trimmed = bad.trim();
      if (trimmed.length > 0) expect(JSON.stringify(vars)).not.toContain(trimmed);
    }
  });

  it('never leaks contact or secret fields into the Retell variables', () => {
    const vars = buildAgentDynamicVariables(
      context({
        customerName: 'Nishka',
        enquiredDestination: 'Nepal',
        phoneE164: '+916291764011',
        phoneTier: 'live_mobile',
        leadFields: { country: 'IN' },
      }),
    );
    const serialized = JSON.stringify(vars);
    expect(serialized).not.toContain('916291764011');
    expect(serialized).not.toContain('live_mobile');
    expect(Object.keys(vars).sort()).toEqual(['customer_name', 'enquired_destination']);
  });
});
