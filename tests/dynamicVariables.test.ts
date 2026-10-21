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
