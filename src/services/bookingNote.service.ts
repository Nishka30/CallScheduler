/**
 * Builds the appointment note from the trip details the agent CONFIRMED with the
 * customer on the call.
 *
 * The team-appointment API has no structured destination field, so the confirmed
 * destination (and any change from the original enquiry) is recorded in the free
 * `notes` string — the supported place to carry it to the consultant.
 *
 * This is a pure string builder: no network, no personal contact data (no phone,
 * email or WhatsApp), and it never invents a value. An absent field is simply
 * omitted. The note always marks itself as AI-call sourced so a human can tell it
 * from a customer-written note.
 */

export interface ConfirmedTripDetails {
  /** The destination the customer confirmed on the call (required to book). */
  confirmedDestination: string;
  /** Specific trek / region, if confirmed. */
  preferredTrek?: string;
  tripDuration?: string;
  groupSize?: string;
  travelTiming?: string;
  specialRequirements?: string;
  /**
   * The destination originally enquired about, ONLY when it differs from the
   * confirmed one — used to record a confirmed change without touching the CRM
   * record itself.
   */
  changedFromDestination?: string;
}

/** Caps so a single over-long model field can never bloat the note. */
const FIELD_MAX = 300;
const NOTE_MAX = 1500;

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > FIELD_MAX ? `${trimmed.slice(0, FIELD_MAX - 1)}…` : trimmed;
}

export function buildBookingNote(trip: ConfirmedTripDetails): string {
  const destination = clean(trip.confirmedDestination);
  const changedFrom = clean(trip.changedFromDestination);

  const lines: string[] = [
    'Consultation booked via AI caller (details confirmed with the customer).',
  ];

  if (destination) {
    // Only call it a change when a different original destination was supplied.
    if (changedFrom && changedFrom.toLowerCase() !== destination.toLowerCase()) {
      lines.push(
        `Destination: ${destination} (customer confirmed a change from their original enquiry: ${changedFrom}).`,
      );
    } else {
      lines.push(`Destination: ${destination}.`);
    }
  }

  const add = (label: string, value: string | undefined): void => {
    const v = clean(value);
    if (v) lines.push(`${label}: ${v}.`);
  };

  add('Trek/region', trip.preferredTrek);
  add('Trip duration', trip.tripDuration);
  add('Group size', trip.groupSize);
  add('Preferred timing', trip.travelTiming);
  add('Requirements', trip.specialRequirements);

  const note = lines.join('\n');
  return note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX - 1)}…` : note;
}
