# Calendar / booking integration (Oct 20 brief)

> Updated 20 Oct 2026 for David's authoritative brief "AI caller brief: booking
> calls for Himalayan Wonders leads". It **supersedes** the Oct 16 per-agent
> booking: there is now **one team scheduling module** behind two per-lead
> endpoints, booking does **not** assign the lead, and the test runs on
> **Himalayan Wonders only**.
>
> **No live booking has been made.** Writes need the key scope
> `notes,assignment,appointments`, not yet enabled → every booking POST returns 403. Reads were verified live. Both feature flags stay `false`.

## What changed vs. the Oct 16 implementation

| Area         | Oct 16 (removed)                                  | Oct 20 (now)                                                                  |
| ------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Availability | `GET /api/crm/agents` + per-agent `/slots`        | `GET /api/crm/leads/<id>/team-slots`                                          |
| Booking      | `POST /api/crm/appointments` (agent chosen by us) | `POST /api/crm/appointments/team` (server routes owner-first + rotation)      |
| Agent choice | caller selected the agent                         | server decides; `decision.mode` = `owner`/`pool`/`none`                       |
| Assignment   | booking could assign                              | booking **never** assigns — agent lands in previous-owner fields              |
| Write auth   | `X-Agent-Email`                                   | `X-Agent-Email` **and** `X-Agent-Name`                                        |
| Poll scope   | all brands                                        | `brand=HW` (test), configurable via `LEAD_TEST_BRAND`                         |
| No-booking   | —                                                 | one note; declined → optional `/api/public/lead-forward`; no-answer → no note |

The old `agentSelection.service.ts` and the per-agent client methods were removed.

## Verified live contract (read-only, 2026-10-20)

- **Lead fields** present: `crm_route`, `booked_call`, `sales_agent_email`,
  `is_deleted`, `caller_hold_until`, `phone` (all currently `null`/unset on
  sampled rows).
- **`team-slots`** →
  `{ lead_id, brand, decision: { mode, fallback, reason, owner }, owner, agents[{email,name,...}], from, to, slots[{starts_at, ends_at, agents[], local}] }`.
  A live call returned `decision.mode = "pool"`, 6 agents, 778 slots; `local`
  differs per `tz` for the same `starts_at`.
- **`POST /appointments/team`** (201, per brief) →
  `{ appointment:{id,...}, agent:{name,email,...}, decision, free_agents[] }`.
  Not callable live (scope disabled) — schema validated, booking mocked.

### ⚠️ Open contract item — `brand=HW` returns 0 leads

`GET /api/crm/leads?brand=HW` is accepted (200) but returns **0 rows**, while the
`brand` field on lead rows is the domain `himalayanwonders.com` (196 rows in a
90-day sample). The brief says poll with `brand=HW`. We implement `brand=HW`
(configurable), but **David must confirm** whether the poll filter value is the
code `HW` or the domain `himalayanwonders.com` — otherwise the HW test polls
nothing. This is the top prerequisite below.

## Eligibility (Oct 20 §1)

A lead is called only when ALL hold (`crmGate.service.ts` + the existing hold
check): phone present · `is_deleted` false · `sales_agent_email` null ·
`booked_call` null · `crm_route` null (not `legacy`/`crm`) · and
`caller_hold_until` in the future (the active-hold check, applied separately —
`crm_route` null alone is **not** taken as proof of an active hold). The
orchestrator applies this gate before any dial.

## Booking flow (`appointmentBooking.service.ts`)

Pre-flight: customer agreed · `decision.mode` ≠ `none` · a slot was offered ·
valid `meeting_type` · IANA timezone · chosen slot was in the latest offer. Then
`POST /appointments/team` with `{ lead_id, starts_at, meeting_type, customer_tz,
notes, booked_by:"caller" }` — no `agent_email`, `customer_email` or
`customer_phone` (the team endpoint routes and the server handles the rest). On
201: persist `AppointmentRecord`, read back `agent.name` + the time. Failures:
`409 → slot_conflict` (refresh, never retry same start), `403 →
write_scope_disabled`, timeout → `uncertain` (never resubmit; reconcile).

**On success the caller posts no note and sends no email** — the team endpoint
adds the note, sends the confirmation + calendar invite, cancels the legacy
forward, and writes the agent to the previous-owner fields.

## No booking (`noBooking.service.ts`, §4)

- wants-a-call-later / gave details → **one** `POST /api/crm/leads/<id>/notes`.
- declines → the note **and** optionally `POST /api/public/lead-forward` (public,
  no auth headers) to reach legacy now instead of on the timer.
- no answer → **no note**; the timer forwards the lead.

## The "Do not" rules (enforced structurally)

- No `/assignment` call and no `lead_status` write anywhere (the caller never
  assigns or changes status) — asserted by `readOnlyGuarantee.test.ts`.
- No ActiveCampaign writes (none in the codebase).
- No booking via the old `/api/crm/appointments` with a chosen agent — that path
  was removed; only the team endpoint remains.
- `brand` other than HW is excluded from the test by `LEAD_TEST_BRAND`.

## Local persistence — migration PREPARED, NOT APPLIED

`AppointmentRecord` (`appointment_records`): `leadId`, unique `appointmentId`,
`agentEmail`, `startsAt`, `status`, `meetingType`, `decisionMode` — no contact /
card / passport / payment data. Migration
`20261020000000_appointment_records` is generated and **pending review**; it has
**not** been applied. Applied to local `ai_caller` only, via `migrate deploy`,
after approval. Neon is never touched.

## Write identity (§Access)

Every authorised CRM write sends `X-Agent-Email` (`CRM_AGENT_EMAIL`, default
`ai-caller@himalayanwonders.com`) and `X-Agent-Name` (`CRM_AGENT_NAME`, default
`AI Caller`). Both are config, not secrets, kept out of source.

## Prerequisites for the first authorized Himalayan Wonders test

1. **Confirm the poll filter**: does `brand=HW` return HW leads, or must we use
   `brand=himalayanwonders.com`? (Live `brand=HW` returns 0 today.)
2. David enables key scope `notes,assignment,appointments` (else booking = 403).
3. David supplies an authorized HW **test lead** (`davidurmann+<n>@gmail.com` via
   `/everest`) with a phone, `crm_route=null`, and an active `caller_hold_until`
   (needs `CALLER_HOLD_MINUTES` non-zero).
4. Apply the `appointment_records` migration to `ai_caller` (after approval).
5. A documented, independently-tested conversation path that gathers timezone,
   meeting type, chosen slot and explicit agreement.
6. Explicit go-ahead — `RETELL_CALLING_ENABLED` / `LEAD_ELIGIBILITY_AUTO_ENABLED`
   stay `false` until then.
