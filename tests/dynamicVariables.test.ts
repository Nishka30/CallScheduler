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

  it('invents no other variables (no trip/destination/budget/date)', () => {
    const vars = buildAgentDynamicVariables(
      context({
        customerName: 'John',
        brand: 'himalayan',
        trek: 'Everest Base Camp',
        timing: 'March',
        tripLength: '2 weeks',
      }),
    );
    expect(vars).toEqual({ customer_name: 'John', brand_name: 'himalayan' });
  });
});
