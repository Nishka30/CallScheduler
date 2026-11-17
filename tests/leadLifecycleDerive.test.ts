import { describe, it, expect } from 'vitest';
import {
  deriveLeadLifecycleState,
  LifecycleEvent,
  LifecycleStatus,
  type DerivableEvent,
  type DerivableCall,
} from '../src/services/leadLifecycle.service.js';

/**
 * Unit tests for the deterministic lifecycle-state derivation that replaces the
 * old "missed/picked" guesswork. Pure function — no DB, no mocks.
 */

let t = 0;
function ev(event: string, status: string | null = null, reason: string | null = null): DerivableEvent {
  t += 1000;
  return { event, status, reason, createdAt: new Date(t).toISOString() };
}
function call(status: string, outcome: string | null = null): DerivableCall {
  return { status, outcome };
}

describe('deriveLeadLifecycleState', () => {
  it('Case 1 — received → phone → attempt → retell → completed is COMPLETED_NO_BOOKING, never missed', () => {
    const events = [
      ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED),
      ev(LifecycleEvent.PHONE_CHECKED, LifecycleStatus.PASSED),
      ev(LifecycleEvent.CALL_ATTEMPT, LifecycleStatus.ATTEMPTED),
      ev(LifecycleEvent.RETELL_INITIATED, LifecycleStatus.INITIATED),
      ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'),
    ];
    const r = deriveLeadLifecycleState(events, call('COMPLETED', 'NOT_INTERESTED'));
    expect(r.state).toBe('COMPLETED_NO_BOOKING');
    expect(r.bookingStatus).toBe('NO_BOOKING');
    expect(r.label).not.toMatch(/miss/i);
  });

  it('Case 2 — a BOOKED event (or APPOINTMENT_BOOKED outcome) yields BOOKED', () => {
    const base = [
      ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED),
      ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'),
      ev(LifecycleEvent.BOOKED, LifecycleStatus.BOOKED),
    ];
    const r = deriveLeadLifecycleState(base, call('COMPLETED', 'APPOINTMENT_BOOKED'));
    expect(r.state).toBe('BOOKED');
    expect(r.bookingStatus).toBe('BOOKED');

    // Booking is also derivable from the call outcome alone (no BOOKED event).
    const r2 = deriveLeadLifecycleState(
      [ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED')],
      call('COMPLETED', 'APPOINTMENT_BOOKED'),
    );
    expect(r2.state).toBe('BOOKED');
    expect(r2.bookingStatus).toBe('BOOKED');
  });

  it('Case 3 — completed without booking is COMPLETED_NO_BOOKING', () => {
    const r = deriveLeadLifecycleState(
      [ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED')],
      call('COMPLETED', 'NOT_REACHED'),
    );
    expect(r.state).toBe('COMPLETED_NO_BOOKING');
    expect(r.bookingStatus).toBe('NO_BOOKING');
  });

  it('Case 4 — received but processing stopped reports the exact stop, not "missed"', () => {
    const receivedOnly = deriveLeadLifecycleState([ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED)], null);
    expect(receivedOnly.state).toBe('RECEIVED');

    const phoneInvalid = deriveLeadLifecycleState(
      [ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED), ev(LifecycleEvent.PHONE_CHECKED, LifecycleStatus.REJECTED, 'phone_not_validated')],
      null,
    );
    expect(phoneInvalid.state).toBe('PHONE_INVALID');
    expect(phoneInvalid.stoppedReason).toBe('phone_not_validated');

    const notProcessed = deriveLeadLifecycleState(
      [
        ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED),
        ev(LifecycleEvent.PHONE_CHECKED, LifecycleStatus.PASSED),
        ev(LifecycleEvent.CALL_ATTEMPT, LifecycleStatus.REJECTED, 'crm_route_excluded'),
      ],
      null,
    );
    expect(notProcessed.state).toBe('RECEIVED_NOT_PROCESSED');
    expect(notProcessed.stoppedReason).toBe('crm_route_excluded');
  });

  it('Case 5 — no events and no call is NOT_RECEIVED (distinct from RECEIVED)', () => {
    const r = deriveLeadLifecycleState([], null);
    expect(r.state).toBe('NOT_RECEIVED');
    expect(r.bookingStatus).toBeNull();
  });

  it('Case 6 — retell initiated but not completed is IN_PROGRESS', () => {
    const r = deriveLeadLifecycleState(
      [
        ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED),
        ev(LifecycleEvent.CALL_ATTEMPT, LifecycleStatus.ATTEMPTED),
        ev(LifecycleEvent.RETELL_INITIATED, LifecycleStatus.INITIATED),
      ],
      call('IN_PROGRESS'),
    );
    expect(r.state).toBe('IN_PROGRESS');
    expect(r.bookingStatus).toBeNull();
  });

  it('duplicate CALL_COMPLETED events still derive a single COMPLETED state', () => {
    const r = deriveLeadLifecycleState(
      [ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'), ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED')],
      call('COMPLETED'),
    );
    expect(r.state).toBe('COMPLETED_NO_BOOKING');
  });

  it('STATUS_REPORTED is reported after completion; BOOKED still wins over it', () => {
    const reported = deriveLeadLifecycleState(
      [ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'), ev(LifecycleEvent.STATUS_REPORTED, LifecycleStatus.REPORTED)],
      call('COMPLETED'),
    );
    expect(reported.state).toBe('STATUS_REPORTED');

    const bookedWins = deriveLeadLifecycleState(
      [
        ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'),
        ev(LifecycleEvent.BOOKED, LifecycleStatus.BOOKED),
        ev(LifecycleEvent.STATUS_REPORTED, LifecycleStatus.REPORTED),
      ],
      call('COMPLETED', 'APPOINTMENT_BOOKED'),
    );
    expect(bookedWins.state).toBe('BOOKED');
  });

  it('an existing appointment marks the lead BOOKED even when the call outcome is UNKNOWN', () => {
    // Mirrors the real booked lead whose CallRecord.outcome was never set to
    // APPOINTMENT_BOOKED (booking is tracked via AppointmentRecord).
    const events = [
      ev(LifecycleEvent.LEAD_RECEIVED, LifecycleStatus.RECEIVED),
      ev(LifecycleEvent.PHONE_CHECKED, LifecycleStatus.PASSED),
      ev(LifecycleEvent.CALL_ATTEMPT, LifecycleStatus.ATTEMPTED),
      ev(LifecycleEvent.RETELL_INITIATED, LifecycleStatus.INITIATED),
      ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'),
      ev(LifecycleEvent.CALL_COMPLETED, 'COMPLETED'),
    ];
    const r = deriveLeadLifecycleState(events, call('COMPLETED', 'UNKNOWN'), { hasBooking: true });
    expect(r.state).toBe('BOOKED');
    expect(r.bookingStatus).toBe('BOOKED');
  });

  it('call_failed before completion reports CALL_FAILED with its reason', () => {
    const r = deriveLeadLifecycleState(
      [
        ev(LifecycleEvent.CALL_ATTEMPT, LifecycleStatus.ATTEMPTED),
        ev(LifecycleEvent.CALL_FAILED, LifecycleStatus.FAILED, 'provider_error'),
      ],
      call('FAILED'),
    );
    expect(r.state).toBe('CALL_FAILED');
    expect(r.stoppedReason).toBe('provider_error');
  });
});
