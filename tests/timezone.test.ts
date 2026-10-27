import { describe, expect, it } from 'vitest';
import { isValidIanaTimeZone, normalizeTimezone } from '../src/lib/timezone.js';

describe('normalizeTimezone — the four live-tested cases', () => {
  it('passes a valid IANA id through unchanged (Asia/Kolkata → 200 live)', () => {
    expect(normalizeTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('maps the "India Standard Time" alias to Asia/Kolkata (400 live)', () => {
    expect(normalizeTimezone('India Standard Time')).toBe('Asia/Kolkata');
  });

  it('maps the "GMT+5:30" offset to Asia/Kolkata (400 live)', () => {
    expect(normalizeTimezone('GMT+5:30')).toBe('Asia/Kolkata');
  });

  it('returns null (safe fallback) for an unknown value ("invalid-zone", 400 live)', () => {
    expect(normalizeTimezone('invalid-zone')).toBeNull();
  });
});

describe('normalizeTimezone — aliases & offsets', () => {
  it('handles IST / case / spacing', () => {
    expect(normalizeTimezone('IST')).toBe('Asia/Kolkata');
    expect(normalizeTimezone('  india   standard time  ')).toBe('Asia/Kolkata');
  });

  it('parses GMT/UTC/bare offset spellings for +5:30', () => {
    for (const v of ['GMT+5:30', 'UTC+05:30', '+05:30', '+0530', 'gmt+5:30']) {
      expect(normalizeTimezone(v)).toBe('Asia/Kolkata');
    }
  });

  it('converts a whole-hour offset to an IANA Etc zone (CRM-safe name, correct sign)', () => {
    // The CRM rejects "GMT-8"; Etc/GMT+8 is the IANA zone for UTC-8 (sign inverted).
    expect(normalizeTimezone('GMT-8')).toBe('Etc/GMT+8');
    expect(normalizeTimezone('UTC+5')).toBe('Etc/GMT-5');
    expect(normalizeTimezone('GMT+0')).toBe('UTC');
  });

  it('maps other known half-hour offsets to their canonical zones', () => {
    expect(normalizeTimezone('GMT+5:45')).toBe('Asia/Kathmandu');
  });

  it('passes other valid IANA ids through (Asia/Calcutta, UTC, America/New_York)', () => {
    expect(normalizeTimezone('Asia/Calcutta')).toBe('Asia/Calcutta');
    expect(normalizeTimezone('UTC')).toBe('UTC');
    expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
  });

  it('maps common named zones (Eastern / London)', () => {
    expect(normalizeTimezone('Eastern Standard Time')).toBe('America/New_York');
    expect(normalizeTimezone('London')).toBe('Europe/London');
  });

  it('returns null for empty, whitespace, null/undefined and nonsense', () => {
    expect(normalizeTimezone('')).toBeNull();
    expect(normalizeTimezone('   ')).toBeNull();
    expect(normalizeTimezone(null)).toBeNull();
    expect(normalizeTimezone(undefined)).toBeNull();
    expect(normalizeTimezone('not a timezone at all')).toBeNull();
    // A half-hour offset with no canonical IANA zone is NOT guessed.
    expect(normalizeTimezone('GMT+2:30')).toBeNull();
    // An out-of-range offset is rejected.
    expect(normalizeTimezone('GMT+20')).toBeNull();
  });

  it('every mapping it returns is a real IANA id the runtime accepts', () => {
    for (const v of ['India Standard Time', 'GMT+5:30', 'GMT-8', 'UTC+5', 'London', 'IST']) {
      const z = normalizeTimezone(v);
      expect(z).not.toBeNull();
      expect(isValidIanaTimeZone(z!)).toBe(true);
    }
  });
});

describe('isValidIanaTimeZone', () => {
  it('accepts real zones and rejects junk', () => {
    expect(isValidIanaTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
    expect(isValidIanaTimeZone('invalid-zone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
  });
});
