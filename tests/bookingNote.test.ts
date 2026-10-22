import { describe, expect, it } from 'vitest';
import { buildBookingNote } from '../src/services/bookingNote.service.js';

describe('buildBookingNote', () => {
  it('records the confirmed destination and the present trip details only', () => {
    const note = buildBookingNote({
      confirmedDestination: 'Nepal',
      preferredTrek: 'Everest region',
      tripDuration: '8–11 days',
      groupSize: 'Individual',
      travelTiming: '2026',
      specialRequirements: 'Wants about 10 days',
    });
    expect(note).toContain('AI caller');
    expect(note).toContain('Destination: Nepal.');
    expect(note).toContain('Trek/region: Everest region.');
    expect(note).toContain('Trip duration: 8–11 days.');
    expect(note).toContain('Group size: Individual.');
    expect(note).toContain('Preferred timing: 2026.');
    expect(note).toContain('Requirements: Wants about 10 days.');
  });

  it('omits fields that are absent rather than inventing them', () => {
    const note = buildBookingNote({ confirmedDestination: 'Nepal' });
    expect(note).toContain('Destination: Nepal.');
    expect(note).not.toContain('Trek/region');
    expect(note).not.toContain('Group size');
  });

  it('marks a confirmed destination change', () => {
    const note = buildBookingNote({
      confirmedDestination: 'Patagonia',
      changedFromDestination: 'Nepal',
    });
    expect(note).toContain('Destination: Patagonia');
    expect(note.toLowerCase()).toContain('change');
    expect(note).toContain('Nepal');
  });

  it('does not treat an unchanged destination as a change', () => {
    const note = buildBookingNote({
      confirmedDestination: 'Nepal',
      changedFromDestination: 'nepal',
    });
    expect(note).toContain('Destination: Nepal.');
    expect(note.toLowerCase()).not.toContain('change');
  });

  it('caps an over-long requirement field', () => {
    const note = buildBookingNote({
      confirmedDestination: 'Nepal',
      specialRequirements: 'x'.repeat(5000),
    });
    expect(note.length).toBeLessThanOrEqual(1500);
  });
});
