# AI Caller — Architecture

## Purpose

The AI Caller places outbound voice calls to **new** travel leads, has a natural
conversation grounded in the lead's existing travel-form answers, books a
consultation when appropriate, and writes a single plain-text note back to the
CRM.

This document describes the system boundaries and the planned integration flow.
Only **Phase 1 (foundation)** is implemented today; everything marked _planned_
is design intent, not working code.

## System boundaries

| System         | Role                                                                              | Direction       | Status      |
| -------------- | --------------------------------------------------------------------------------- | --------------- | ----------- |
| **Lead API**   | Source of truth for leads, person history, form responses, assignments, CRM notes | AI Caller → API | _planned_   |
| **Retell**     | Outbound voice calls, call status, transcripts, completion webhooks               | both directions | _planned_   |
| **Calendly**   | Consultation availability and appointment booking                                 | AI Caller → API | _planned_   |
| **PostgreSQL** | The AI Caller's own processing records and call history                           | owned by us     | implemented |

The critical ownership rule: **the Lead API owns lead data; we own processing
state.** We never mirror the CRM. Our database holds only what we need to decide
whether a lead should be called, to prevent duplicate calls, and to record what
happened on each call.

## Layering

```
HTTP request
    ↓
routes/        URL shape and method only
    ↓
controllers/   parse + validate input, choose a status code; no business logic
    ↓
services/      business logic; the only layer that coordinates decisions
    ↓
repositories/  database access and concurrency rules
    ↓
lib/prisma     a single shared PrismaClient
```

`integrations/` was added in Phase 2 for outbound API clients. It sits beside
`lib/`: services depend on it, it depends on nothing above it. Keeping provider
clients out of `services/` lets the eligibility rules be unit-tested without any
knowledge of HTTP.

`config/` is validated once at startup and read by everything else.
`middleware/` wraps the pipeline (correlation id, access logging, error
handling). Dependencies point in one direction only — no layer imports from a
layer above it, which keeps the graph acyclic.

## Data model (Phase 1)

Three tables, each with a narrow job.

### `lead_processing`

One row per lead that has entered our workflow. It answers "have we already
dealt with this lead, and is someone working on it right now?"

Duplicate-call prevention has two independent parts:

1. **`leadId` is unique** — prevents duplicate _rows_, so a lead reappearing in
   a later polling page is recognised as already known.
2. **Version-guarded claiming** — prevents duplicate _work_ on one row. A worker
   claims a lead inside a transaction with a conditional update matching
   `(id, status, version)` and incrementing `version`. When two workers race,
   exactly one update matches a row; the loser sees `count === 0` and backs off.

A unique id alone would not be enough: it stops a second row, not a second
worker acting on the same row.

`claimedAt` / `claimedBy` make an abandoned claim (a worker that crashed
mid-call) visible to a future reaper process.

### `call_records`

One row per actual call attempt — deliberately **not** merged into
`lead_processing`:

- a lead can fail eligibility checks before any call is placed (processing row,
  no call row);
- a lead may have several legitimate attempts if a future retry policy allows
  them.

`retellCallId` is unique so provider webhooks can be processed idempotently: a
redelivered event resolves to the same row instead of creating a second one.

### `integration_cursors`

One row per upstream integration, holding the last safely processed polling
position.

**Advancement rule:** the cursor moves forward only _after_ every item on the
corresponding page has been durably recorded. If the process restarts
mid-page, we re-read from the last committed position. Re-reading is safe
because the unique `leadId` makes re-ingestion a no-op.

The row carries both an opaque `cursor` and a `watermarkAt` timestamp because
the Lead API's pagination and `since` semantics are **not yet verified**. The
correct field will be chosen in Phase 2 against the real contract; they are not
assumed to be interchangeable.

## Lead API integration (Phase 2, read-only)

Base URL `https://guided-boost.lovable.app`, routes under `/api/crm/`. Every
request carries `X-Lead-API-Key`, read from validated configuration and never
logged.

**The caller's key is read-only, and Phase 2 implements no writes at all.** Only
three GET endpoints are used:

| Endpoint                           | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `GET /api/crm/leads`               | incremental listing; discovery                                 |
| `GET /api/crm/leads/<id>`          | lead detail, corrections, questionnaire answers, phone verdict |
| `GET /api/crm/persons/<personKey>` | person history for call context                                |

`GET /api/crm/search` and `GET /api/crm/emails` are deliberately unused: the
listing plus detail covers the polling workflow, and neither contract has been
verified against a real response.

### `since`, `cursor` and `nextCursor`

Three different things, never substituted for one another:

- **`since`** - an ISO timestamp selecting leads changed since that moment. Used
  only on the **first request of a run**, seeded from the durable watermark.
- **`cursor`** - an opaque pagination token, passed back **exactly** as the API
  returned it. Used for every request after the first.
- **`nextCursor`** - the response field. Non-null means another page exists.

Two guards sit around this. A `nextCursor` equal to the cursor we just sent
would loop forever, so the run stops with a contract error instead. And a hard
page bound (`LEAD_POLL_MAX_PAGES`) caps any single run; the next run resumes
from the stored cursor, so nothing is lost.

The listing has no documented key name for the rows array. Rather than guess
one, the parser requires the response to contain exactly one top-level array and
uses that; zero or several is ambiguous and fails loudly with the observed key
names. **A malformed or unexpected response is never treated as an empty page** -
that would silently skip leads.

### How a new lead is distinguished from a changed one

This is the heart of the phase, because the listing returns **new and changed**
inquiries: a note, correction, assignment or status change all bump
`updated_at`. Appearing in a page is never by itself a reason to call.

Each row is judged in order, and the first rule that matches wins:

| #   | Check                                                    | Outcome when it fails                                              |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `is_deleted`                                             | `SKIPPED` / `lead_deleted`                                         |
| 2   | `is_lead === true`                                       | `SKIPPED` / `not_a_lead`, or `NEEDS_REVIEW` if the field is absent |
| 3   | `lead_status` not one of the three documented exclusions | `SKIPPED` / `status_blocked`                                       |
| 4   | not seen during the bootstrap run                        | `SKIPPED` / `known_before_bootstrap`                               |
| 5   | `created_at` present and parsable                        | `NEEDS_REVIEW` / `created_at_field_absent`                         |
| 6   | `LEAD_ELIGIBILITY_AUTO_ENABLED`                          | `NEEDS_REVIEW` / `awaiting_new_lead_rule_confirmation`             |
| 7   | readable, validated E.164 phone verdict                  | `SKIPPED` / `phone_not_validated`, or `NEEDS_REVIEW` if unreadable |

Two deliberate safety properties:

- **Bootstrap protection.** On the very first poll no durable watermark exists,
  so every lead the API returns is pre-existing. Treating those as new would
  dial the entire back catalogue. Instead the first run records them all as
  `known_before_bootstrap` and sets `bootstrapCompletedAt`; only leads arriving
  afterwards can ever be eligible.
- **The master safety switch.** `LEAD_ELIGIBILITY_AUTO_ENABLED` defaults to
  **false**, so nothing is ever marked `ELIGIBLE` automatically. A lead that
  passes every other check lands in `NEEDS_REVIEW` until the product owner
  turns calling on.

**Deliberately absent from this table: a fixed age cutoff.** An earlier version
compared `created_at` against a 60-minute window and skipped anything older.
That rule was not supported by the documented workflow and was actively wrong:
a poller that fell behind schedule would wrongly skip a genuinely new lead once
it crossed the cutoff, even though nothing had ever decided it before. The
thing that actually prevents an old, merely-updated lead from being treated as
new is structural, not a timestamp comparison: `recordLeadDecision` (in the
repository layer) only ever transitions a lead out of `PENDING` once, and
bootstrap protection handles everything present before polling began. Together
those two are sufficient; `created_at` only needs to exist and parse.

**Also deliberately absent: a `caller_hold_until` gate.** The caller hold is a
timing window, not an eligibility rule, and the two are kept strictly separate
(this is a hard requirement of the revised contract). `caller_hold_until` is now
an officially supported field on the collector list and detail reads - an ISO
timestamp or `null`. A future value reserves the lead FOR the AI Caller,
blocking a human sales agent from claiming it until the hold lapses; a `null` or
past value means the lead is already available to sales. That "is there an
active hold, so may the AI Caller proceed?" question is answered on its own by
`evaluateCallWindow()` in `callWindow.service.ts`, never by the eligibility
rules above - every one of which still applies regardless of the hold. The
value is also carried into the call context (`LeadCallContext.callerHoldUntil`)
for a future caller to use when timing an attempt.

### What happens to a skipped lead

Nothing further, and the decision is permanent. The processing record keeps
`status`, `decisionReason` and a short non-personal `decisionDetail`, so any
skip can be explained later without storing the lead's data.

Crucially, a decision is recorded **once**. `recordLeadDecision` only updates a
row still in `PENDING`, which means a later note, correction or status change
can never promote an old lead back into the calling queue - the exact failure
mode the product owner ruled out.

### Durability

The order within a page is strict: fetch, then decide and record **every** row,
and only then advance the cursor. A crash mid-page leaves the cursor where it
was, the page is re-read next run, and the unique `leadId` makes re-ingestion a
no-op. The watermark also never moves backwards, so an out-of-order page cannot
rewind progress.

A transient failure while fetching call context stops the run and leaves the
lead `PENDING` for the next poll, rather than marking it eligible with missing
context. A permanent 4xx is recorded as `NEEDS_REVIEW` so it is not retried
forever.

## Safety rules encoded in the design

These are deliberate constraints, not oversights:

- **Never auto-retry an uncertain outbound call.** `requeueForRetry()` refuses
  to act on a lead in the `CALLING` state. An in-flight call request may already
  have reached a real customer; retrying it would dial them twice. Those leads
  are resolved by webhook reconciliation or a human decision.
- **Never change a lead's status.** CRM writes will be limited to the authorized
  note and assignment workflows.
- **Only new leads are called.** Appearing in a later polling response is not a
  reason to call an old lead.
- **No sensitive data at rest by default.** No transcripts, recordings, passport
  details, or payment information. A retention policy is agreed before any
  additional sensitive field is added. `summary` is a short agent summary, not a
  transcript.
- **Validated E.164 numbers only.** A future call path uses the validated phone
  number, never an unvalidated raw field.
- **Secrets never reach the logs or the database.** The logger redacts auth
  headers, keys, and personal fields; `sanitizeErrorMessage()` strips
  credentials from anything stored in `lastError`.

## Planned integration flow

```
            ┌──────────────────────────────────────────────┐
            │ Phase 2 — poll the Lead API for NEW leads    │
            │ read integration_cursors → fetch page →      │
            │ record leads → advance cursor only after     │
            │ the page is durably recorded                 │
            └──────────────────────────────────────────────┘
                              ↓
            ┌──────────────────────────────────────────────┐
            │ claim a lead atomically (version guard)      │
            │ fetch lead details + person history          │
            │ verify eligibility + validated E.164 number  │
            └──────────────────────────────────────────────┘
                              ↓
            ┌──────────────────────────────────────────────┐
            │ Phase 3 — Retell call                        │
            │ create call_record → initiate → map          │
            │ retellCallId → authenticated webhook →       │
            │ idempotent event processing → outcome        │
            └──────────────────────────────────────────────┘
                              ↓
            ┌──────────────────────────────────────────────┐
            │ Phase 4 — Calendly                           │
            │ availability → confirmed booking → route to  │
            │ the existing rep, or assign an agent only    │
            │ when unassigned AND the booking succeeded    │
            └──────────────────────────────────────────────┘
                              ↓
            ┌──────────────────────────────────────────────┐
            │ Phase 5 — CRM workflow                       │
            │ exactly one plain-text note per call         │
            │ documented assignment workflow               │
            │ never change lead status                     │
            └──────────────────────────────────────────────┘
```

The conversation uses existing travel-form answers as context: known details are
confirmed naturally rather than re-asked, and the agent only gathers what is
missing or genuinely useful.

## Operational surface

| Endpoint            | Purpose   | Behaviour                                                 |
| ------------------- | --------- | --------------------------------------------------------- |
| `GET /health`       | Liveness  | 200 while the process can serve requests; touches nothing |
| `GET /health/ready` | Readiness | 200 when PostgreSQL answers `SELECT 1`, else 503          |

They are separate on purpose: an orchestrator should **restart** on liveness
failure but only **stop routing traffic** on readiness failure. A transient
database outage must not trigger a restart loop.

Readiness returns `up`/`down` only. Connection strings, SQL, and stack traces
are logged internally and never returned.

Both are unauthenticated: they expose no data, and probes typically cannot
present credentials. Future administrative and write endpoints — including the
Retell webhook — must be authenticated before they are added.

## Error handling

Every failure leaves through one middleware and takes a consistent shape:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /nope not found",
    "requestId": "4728aec0-582e-425f-a2b8-07cd3aae1ad8"
  }
}
```

Only `AppError` messages are considered safe to return. Anything unexpected
becomes a generic `INTERNAL_ERROR` 500 — the real message and stack are logged
against the `requestId` and never sent to the client.

## Contract status

Verified on 2026-10-14 against the live API with read-only GETs (2400 rows
sampled over 90 days). No write was made.

**Resolved by live data:**

| Question           | Answer                                   |
| ------------------ | ---------------------------------------- |
| Rows key           | `leads`                                  |
| Creation timestamp | `created_at`, present on every row       |
| `is_lead`          | real column; `true` on 118 of 2400 rows  |
| `lead_status`      | real column; `null` on 2293 of 2400 rows |
| Phone verdict      | `phone_e164` + `valid`, not `e164`       |
| Travel details     | in `answers[]`, not in lead columns      |

**Resolved by the product owner directly:**

| Question                              | Answer                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How recent counts as "new"            | No fixed window - new means "not present at bootstrap, never decided before" (see above)                                                                                          |
| Which statuses block calling          | Exactly `Unsubscribe`, `Closed`, `Post Trip` - no others added without confirmation                                                                                               |
| Newsletter records                    | Not excluded unless confirmed                                                                                                                                                     |
| Canonical write identity              | Confirmed as `ai-caller@himalayanwonders.com` for the future `X-Agent-Email` header, resolving the Lead API doc's inconsistent examples - not used yet, no write code exists      |
| `caller_hold_until` field             | Officially supported on the collector list and detail reads (revised contract): an ISO timestamp or null. A future value = held FOR the AI Caller; null/past = available to sales |
| Hold duration (`CALLER_HOLD_MINUTES`) | A Lead API setting. Currently **0** (so `caller_hold_until` is `null` for effectively every lead); to be raised to **10 minutes** when caller testing begins                      |

**Still unverified:**

1. **How a caller attempt ends the hold early.** The workflow doc says a caller
   attempt ends the hold early, but names no endpoint or mechanism. "Do not
   invent CRM endpoints or writes to manage the hold" remains the rule until
   this is confirmed; until then a hold simply expires on its own timer.
2. **`profile.salesAgent` shape.** Null throughout the sample. Both a bare
   string and an object with `email` are accepted.

**Carried into later phases:**

- Hold acquisition and release semantics - specifically, what reports a caller
  attempt and ends the hold early, and what endpoint (if any) that requires.
  "Do not invent CRM endpoints or writes to manage the hold" remains the rule
  until this is confirmed.
- The call-record and note endpoints, and `ai-caller@himalayanwonders.com` as
  the `X-Agent-Email` identity for those writes (now confirmed, but unused
  until Phase 5).
- Retell webhook event names, payload shape, and signature scheme.
- Calendly event types and per-agent availability configuration.

## Preparing for Phase 3 (Retell) and Phase 4 (Calendly)

This section records what is ready, what was deliberately built now, and what
genuinely cannot proceed without David's input. Nothing here places a call,
writes to the CRM, or books an appointment.

### Already ready

- **Call context.** `buildLeadCallContext()` produces everything the workflow
  document asks for: validated phone, customer name, the six confirmed
  questionnaire answers, free text, and a condensed person history (prior
  inquiry/booking/call counts, current agent). It is built fresh per call
  attempt and never persisted, so Phase 3 will not speak from a stale copy.
- **Our own call storage.** The `CallRecord` Prisma model (lead id, provider
  call id, status, outcome, summary, timestamps) was defined in Phase 1 and
  needs no changes - it was already designed for a future call integration.
- **The caller hold, read correctly.** `evaluateCallWindow()` (in
  `callWindow.service.ts`) classifies a lead as `within_hold` or
  `no_active_hold` from `caller_hold_until`, per the revised contract: a future
  timestamp is `within_hold` (held for the AI Caller, so the call workflow may
  proceed subject to every other eligibility check); a `null`, past, or
  unparsable value is `no_active_hold` (available to the sales team, so the AI
  Caller must not place a late call). `isHoldActive()` exposes that single
  go/no-go. It is pure and side-effect free - no network call, no database
  access. Both Lead API hold settings are handled with no code change: at
  `CALLER_HOLD_MINUTES = 0` (today) every lead is `no_active_hold`; at 10
  minutes a fresh lead is `within_hold` until the window lapses.
- **Call-attempt tracking, separate from the hold.** `caller_hold_until` only
  reports whether a hold is active - never whether a lead has been called. That
  is tracked independently per lead id in `callRecord.repository.ts`
  (`recordCallAttempt`, `hasActiveCallAttempt`), which refuses to open a second
  attempt while one is still unresolved. Combined with the version-guarded claim
  in `lead_processing`, a lead cannot be dialled twice. A partial unique index
  on `call_records` (documented in the repository) is recommended as a
  database-level guard when calls are actually created in Phase 3; it is
  **prepared but intentionally not applied** this round.

### What was deliberately NOT built

No Retell or Calendly client code, no webhook handler, and no `Booking` model
exist yet. Building any of them now would mean guessing at an unconfirmed
contract - exactly what "do not invent undocumented API behavior" rules out.
When each contract is confirmed, the new client should follow the same shape
as `src/integrations/leadApi/`: a small typed client, Zod-defended response
parsing, and a service layer that keeps business rules out of the HTTP layer.

### Dependencies on David - API and calendar information

**Retell (Phase 3):**

1. Base URL, authentication scheme, and API key.
2. The call-initiation request shape: how `LeadCallContext` fields (phone,
   name, trek, timing, answers, history) map onto whatever Retell's agent
   expects as dynamic variables or a system prompt.
3. Whether the calling agent and its script are already configured in Retell,
   or need to be built as part of this phase.
4. Webhook contract: registration, event names, payload shape, and the
   signature/auth scheme to verify an incoming webhook is genuine.
5. How a call's outcome (summary, success/voicemail/no-answer) is reported
   back, and what maps onto `CallRecord.outcome`.
6. **How a caller attempt is reported to the Lead API**, to end the hold early
   as the workflow document describes. No endpoint for this is named in either
   document; it has to be confirmed before Phase 3 can report an attempt.
   (Whether to call an expired/absent hold is no longer open: the revised
   contract settles it - `no_active_hold` means do not place a late call.)

**Calendly (Phase 4):**

1. Account access and API credential (personal access token vs. OAuth).
2. The consultation event type(s), and how each maps to a sales agent.
3. How a lead's assigned (or to-be-assigned) agent maps to a specific Calendly
   user, so availability is queried for the right calendar.
4. The real availability and booking endpoints and response shapes - neither
   has been seen, so nothing about their contract can be assumed.
5. What "the booking succeeded" means operationally (a synchronous response?
   a webhook?), since the workflow ties agent assignment directly to that
   outcome: "assign it to the agent whose slot was booked... only when the
   lead is unassigned and the booking succeeds."
6. Timezone handling for availability and the confirmed slot.

### An operational finding worth flagging now

Running the corrected preview (`npm run poll:leads:preview`) over the last 30
days shows **67 of 108** records that would otherwise be held in
`NEEDS_REVIEW` (pending the master switch) are `Newsletter`-status records with
`is_lead === true` - the majority. `Newsletter` is deliberately not in the
blocklist (never confirmed as an exclusion), but this means that, as things
stand, turning on `LEAD_ELIGIBILITY_AUTO_ENABLED` without first deciding on
`Newsletter` would make most of the AI Caller's "new lead" attempts newsletter
signups rather than travel inquiries. This is reported as data, not assumed as
a reason to add the exclusion.
