import { describe, expect, it } from 'vitest';
import { isExpectedUniqueConstraintEvent } from '../src/lib/prisma.js';

describe('isExpectedUniqueConstraintEvent', () => {
  it("matches the query engine's standard P2002 wording", () => {
    const message =
      'Invalid `prisma.leadProcessing.create()` invocation\nUnique constraint failed on the fields: (`leadId`)';
    expect(isExpectedUniqueConstraintEvent(message)).toBe(true);
  });

  it('matches regardless of which table/column the constraint is on', () => {
    expect(
      isExpectedUniqueConstraintEvent('Unique constraint failed on the fields: (`retellCallId`)'),
    ).toBe(true);
    expect(
      isExpectedUniqueConstraintEvent('Unique constraint failed on the fields: (`appointmentId`)'),
    ).toBe(true);
  });

  it('does not match an unrelated database error', () => {
    expect(isExpectedUniqueConstraintEvent('Connection terminated unexpectedly')).toBe(false);
    expect(isExpectedUniqueConstraintEvent('Foreign key constraint failed')).toBe(false);
    expect(isExpectedUniqueConstraintEvent('Timed out fetching a new connection')).toBe(false);
  });
});
