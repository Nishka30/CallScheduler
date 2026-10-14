import { describe, expect, it } from 'vitest';
import { CallOutcome, CallStatus } from '@prisma/client';
import { mapRetellResult } from '../src/integrations/retell/outcomeMap.js';

/**
 * The mapping is contract-pending: until David confirms the provider's result
 * vocabulary, every input must map to UNKNOWN/UNKNOWN. These tests lock in that
 * safe default so a call can never be silently mislabelled as a success before
 * the real mapping is filled in.
 */
describe('mapRetellResult', () => {
  it('defaults any payload to UNKNOWN status and UNKNOWN outcome', () => {
    expect(mapRetellResult({ anything: 'at all' })).toEqual({
      status: CallStatus.UNKNOWN,
      outcome: CallOutcome.UNKNOWN,
    });
  });

  it('defaults for empty, null and primitive inputs too', () => {
    expect(mapRetellResult(undefined)).toEqual({
      status: CallStatus.UNKNOWN,
      outcome: CallOutcome.UNKNOWN,
    });
    expect(mapRetellResult(null)).toEqual({
      status: CallStatus.UNKNOWN,
      outcome: CallOutcome.UNKNOWN,
    });
    expect(mapRetellResult('ended')).toEqual({
      status: CallStatus.UNKNOWN,
      outcome: CallOutcome.UNKNOWN,
    });
  });

  it('never throws on a bogus payload', () => {
    expect(() => mapRetellResult({ call_status: 'weird', disconnection_reason: 42 })).not.toThrow();
  });
});
