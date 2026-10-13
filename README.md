# AI Caller — Backend

Backend foundation for an AI-powered outbound caller for travel leads.

The service calls **new** travel leads, holds a natural conversation grounded in
their existing travel-form answers, books a consultation when appropriate, and
writes a single note back to the CRM.

> **Status: Phases 1-2 complete.**
> The Lead API integration is **read-only**: it discovers and judges leads, and
> writes nothing back to the CRM. **Retell, Calendly, CRM writes and outbound
> calling are not implemented.** No phone call can be placed by this codebase.
> See [Implementation phases](#implementation-phases).

## What is implemented

- TypeScript (strict) + Express 5 on Node.js 22 LTS
- Zod-validated environment configuration, failing fast at startup
- Pino structured logging with sensitive-field redaction
- PostgreSQL via Prisma, with a single shared client
- Three Phase 1 models: `LeadProcessing`, `CallRecord`, `IntegrationCursor`
- `GET /health` (liveness) and `GET /health/ready` (readiness)
- Correlation ids, central error handling, consistent JSON errors
- Security headers (Helmet), non-wildcard CORS, JSON body size limit
- Graceful shutdown for the HTTP server and the database client
- Read-only Lead API client with bounded retries and defensive parsing
- Incremental lead polling with durable cursor and bootstrap protection
- Explicit new-vs-changed lead eligibility, with automatic calling disabled
- 220 unit/integration tests, ESLint + Prettier

## Architecture

```
src/
  app.ts                 Express application wiring
  server.ts              startup, signal handling, graceful shutdown
  config/env.ts          Zod-validated environment contract
  routes/                URL shape only
  controllers/           thin request handlers
  services/              business logic (eligibility, polling, call context)
  repositories/          database access and concurrency rules
  integrations/leadApi/  read-only Lead API client and response schemas
  middleware/            correlation id, access logging, errors, 404
  lib/                   Prisma client, logger, errors, shutdown
  scripts/pollLeads.ts   manual, local-only poll runner
prisma/
  schema.prisma          database schema
  migrations/            generated migration files
tests/                   unit and integration tests
docs/architecture.md     system boundaries and planned integration flow
```

Dependencies point one way only: routes → controllers → services →
repositories → Prisma. See [`docs/architecture.md`](docs/architecture.md) for
the data model rationale, the duplicate-call prevention design, and the planned
integration flow.

## Prerequisites

- **Node.js ≥ 20.11** (developed and verified on 22.14.0)
- **npm** 10+
- **PostgreSQL 14+** — running locally or reachable over the network

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure PostgreSQL

Create a dedicated database and user. Do not use a superuser for the
application.

```bash
psql -U postgres
```

```sql
CREATE DATABASE ai_caller;
CREATE USER ai_caller_app WITH PASSWORD 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON DATABASE ai_caller TO ai_caller_app;

-- Prisma needs to create tables in the public schema:
\c ai_caller
GRANT ALL ON SCHEMA public TO ai_caller_app;
```

Verify the connection before going further:

```bash
psql "postgresql://ai_caller_app:choose-a-strong-password@localhost:5432/ai_caller" -c "SELECT 1;"
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

Then edit `.env` and set at least `DATABASE_URL`. `.env` is gitignored — never
commit it, and never put real credentials in `.env.example`.

| Variable               | Required | Default       | Notes                                                              |
| ---------------------- | -------- | ------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`         | **yes**  | —             | Must be a `postgresql://` URL. The only DB config.                 |
| `NODE_ENV`             | no       | `development` | `development` \| `test` \| `production`                            |
| `PORT`                 | no       | `3000`        | 1–65535                                                            |
| `LOG_LEVEL`            | no       | `info`        | `fatal`…`trace` \| `silent`                                        |
| `CORS_ALLOWED_ORIGINS` | no       | _(empty)_     | Comma-separated origins. Empty = no CORS headers. `*` is rejected. |

Startup fails with a readable list of problems if anything is missing or
invalid. The offending **values** are never printed, so a bad `DATABASE_URL`
cannot leak into logs.

Retell, Calendly, and Lead API variables are listed in `.env.example` as
_planned_ configuration. They are **not required** and not read in Phase 1.

### 4. Validate and generate Prisma

```bash
npm run prisma:validate    # static schema check — no database needed
npm run prisma:generate    # generate the typed client — no database needed
```

### 5. Apply the initial migration

Two migrations are committed and **neither has been applied to any database**.
Both were generated **offline** with `prisma migrate diff`:

| Migration                              | Contents                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `20261014000000_init`                  | initial schema                                                                                                                 |
| `20261014010000_phase2_lead_discovery` | adds `ELIGIBLE`/`SKIPPED`/`NEEDS_REVIEW` states, the decision columns, and `bootstrapCompletedAt`. Purely additive - no drops. |

The Phase 2 migration uses `ALTER TYPE ... ADD VALUE`, which requires
**PostgreSQL 12 or newer** (the project already targets 14+).

Check your connection first, then apply it:

```bash
npm run prisma:migrate:status   # confirms Prisma can reach the DB
npm run prisma:migrate:deploy   # applies pending migrations
```

`migrate deploy` is the correct command for both an initial setup against a
verified database and for production. It only applies migration files — it never
resets or drops anything.

For **new schema changes during development**, create a migration with:

```bash
npx prisma migrate dev --name describe_your_change
```

This diffs the schema, writes a new migration file, and applies it to your local
database.

> **Never** use `prisma db push` or `prisma migrate reset` as a deployment
> strategy. Both are destructive: they can drop columns and data without a
> migration record. Migrations are the only supported path.

### 6. Run the server

```bash
npm run dev     # development, with reload
```

```bash
curl http://localhost:3000/health
curl -i http://localhost:3000/health/ready
```

## Endpoints

### `GET /health` — liveness

Always `200` while the process can serve requests. Touches no dependency.

```json
{
  "status": "ok",
  "service": "ai-caller",
  "uptimeSeconds": 42,
  "timestamp": "2026-10-13T19:16:37.607Z"
}
```

### `GET /health/ready` — readiness

`200` when PostgreSQL answers, `503` when it does not.

```json
{
  "status": "ready",
  "checks": { "database": { "status": "up", "latencyMs": 3 } },
  "timestamp": "2026-10-13T19:16:37.727Z"
}
```

Liveness and readiness are separate on purpose: an orchestrator should restart
on liveness failure but only stop routing traffic on readiness failure. Failure
responses contain no credentials, SQL, or stack traces.

### Error format

Every error has the same shape, with the correlation id for log lookup:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /nope not found",
    "requestId": "4728aec0-582e-425f-a2b8-07cd3aae1ad8"
  }
}
```

## Lead API integration (read-only)

Base URL `https://guided-boost.lovable.app`, routes under `/api/crm/`.
Authentication is the `X-Lead-API-Key` header on every request, read from
`LEAD_API_KEY_CALLER`.

**The caller's key is read-only and this codebase makes no CRM writes.** Three
GET endpoints are used:

| Endpoint                                          | Purpose                                     |
| ------------------------------------------------- | ------------------------------------------- |
| `GET /api/crm/leads?since=&cursor=&brand=&limit=` | incremental discovery                       |
| `GET /api/crm/leads/<id>`                         | detail, corrections, answers, phone verdict |
| `GET /api/crm/persons/<personKey>`                | person history for call context             |

A test asserts statically that no `POST`/`PUT`/`PATCH`/`DELETE` and no
`X-Agent-Email` header exists anywhere in `src/`.

### `since` vs `cursor` vs `nextCursor`

| Term         | What it is                                     | When used                                                     |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| `since`      | ISO timestamp; leads changed since that moment | first request of a run only, seeded from the stored watermark |
| `cursor`     | opaque pagination token, passed back verbatim  | every request after the first                                 |
| `nextCursor` | response field; non-null means another page    | read from each page, stored durably                           |

The cursor advances **only after every row on a page has been recorded**. A
crash mid-page re-reads that page on the next run, which is harmless because the
unique `leadId` makes re-ingestion a no-op.

### How a lead becomes eligible

The listing returns **new and changed** inquiries - a note, correction,
assignment or status change all bump `updated_at` - so appearing in a page is
never by itself a reason to call. Each row is judged in order:

| #   | Check                                                       | Result when it fails                                             |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `is_deleted` is not true                                    | `SKIPPED` / `lead_deleted`                                       |
| 2   | `is_lead === true`                                          | `SKIPPED` / `not_a_lead` (absent field -> `NEEDS_REVIEW`)        |
| 3   | `lead_status` not one of `Unsubscribe`/`Closed`/`Post Trip` | `SKIPPED` / `status_blocked`                                     |
| 4   | not seen during the bootstrap run                           | `SKIPPED` / `known_before_bootstrap`                             |
| 5   | `created_at` present and parsable                           | `NEEDS_REVIEW` / `created_at_field_absent`                       |
| 6   | `LEAD_ELIGIBILITY_AUTO_ENABLED` is on                       | `NEEDS_REVIEW` / `awaiting_new_lead_rule_confirmation`           |
| 7   | validated E.164 phone verdict                               | `SKIPPED` / `phone_not_validated` (unreadable -> `NEEDS_REVIEW`) |

Not a gate at all: `caller_hold_until`. It reserves the lead _for_ the AI
Caller against human CRM claiming, so its presence is a reason to call soon,
not a reason to skip — see [below](#caller_hold_until).

**Two safety properties worth knowing about:**

- **The first poll calls nobody.** With no stored watermark, every lead the API
  returns already existed, so the bootstrap run records them all as
  `known_before_bootstrap`. Without this, a first run would queue the entire
  back catalogue.
- **`LEAD_ELIGIBILITY_AUTO_ENABLED` defaults to `false`.** While it is off,
  nothing is ever marked `ELIGIBLE` - leads that pass every other check land in
  `NEEDS_REVIEW`. It must stay off until the creation-timestamp contract is
  confirmed (see [Open contract questions](#open-contract-questions)).

### What happens to a skipped lead

Nothing further. The decision is permanent and recorded once: `status`,
`decisionReason` and a short non-personal `decisionDetail`. Because
`recordLeadDecision` only updates a row still in `PENDING`, a later note or
status change can never promote an old lead back into the queue.

## Running a controlled poll

A **local command**, not an HTTP endpoint. The service has no authentication
layer yet, and an unauthenticated route that reaches a real CRM would be the
wrong thing to expose; requiring shell access is the authorization mechanism
until Phase 6 adds a real one.

```bash
# Fetch one small page and print the shape. Writes nothing, not even locally.
npm run poll:leads:dry

# Full batch: read, decide, persist decisions and advance the cursor.
npm run poll:leads

# Skip the per-lead detail/history lookups.
npm run poll:leads -- --no-context
```

Both require `LEAD_API_KEY_CALLER`; without it the command exits with a clear
message naming the variable (never its value). The HTTP server still starts
normally without a key.

`npm run poll:leads:dry` prints the row count, which top-level key held the
rows, whether `nextCursor` was present, and the **column names** of the first
row - never any values. That is what was used to confirm the contract below.

### Disabling it in production

There is nothing to disable at the HTTP layer - no route exists. To prevent
polling entirely, leave `LEAD_API_KEY_CALLER` unset in the production
environment; every poll then fails closed. Keep
`LEAD_ELIGIBILITY_AUTO_ENABLED=false` until the contract is confirmed.

## Lead API contract — verified against live data

Confirmed on 2026-10-14 with read-only GETs (2400 rows sampled over 90 days).
No write was made.

| Previously open               | Answer                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows key in the list response | **`leads`**                                                                                                                                  |
| `nextCursor`                  | present; non-null when another page exists                                                                                                   |
| Creation timestamp            | **`created_at`**, a string on every row                                                                                                      |
| `is_lead`                     | real column. `true` on only **118 of 2400** rows — the rest are visits                                                                       |
| `lead_status`                 | real column, **`null` on 2293 of 2400** rows. Observed values: `Newsletter` (67), `Unsubscribe (M)` (28), `Unsubscribe` (10), `New Lead` (2) |
| Phone verdict shape           | `{ phone_raw, phone_e164, phone_best, valid, tier, line_type, carrier_name, country_iso, lookup_status, checked_at }`                        |
| Travel details                | **not** lead columns — they live in `answers[]`                                                                                              |

### The phone verdict

The E.164 field is **`phone_e164`**, not `e164`. A number is callable only when
`valid === true` **and** `phone_e164` is well-formed; in live data that pairs
with `tier: "live_mobile"`, `line_type: "mobile"`, `lookup_status: "ok"`. An
unvalidated number shows `valid: null` with `tier: "none"`.

`phone_raw` and `phone_best` are **never** dialled — only the validated E.164
value is.

### The travel form

The lead row has no destination, dates, party-size or budget column. Travel
intent comes from `answers[]`, keyed by `questionId`:

| `questionId`        | Question                                            |
| ------------------- | --------------------------------------------------- |
| `confirm_trek`      | What kind of Nepal trek are you considering?        |
| `timing`            | When are you looking to start the trek?             |
| `trip_length`       | How long do you have for the trip?                  |
| `group_size`        | How many are in your group?                         |
| `experience`        | How much trekking or hiking experience do you have? |
| `been_before`       | Have you been trekking in Nepal before?             |
| `name` / `whatsapp` | contact details                                     |

**There is no budget question on the form.** Answers are mapped onto the call
context and also kept whole, so nothing is lost.

### `caller_hold_until`

A real column on every row, but **never populated** in the sampled data. The
_business concept_ it is assumed to represent is now confirmed directly by the
product owner: a 10-minute hold that reserves a newly arrived lead **for the AI
Caller**, blocking a human sales agent from claiming it through the CRM during
that window. The hold ends early when a caller attempt is reported, or expires
automatically otherwise.

That makes an earlier version of this check backwards: it treated a future
`caller_hold_until` as a reason to **skip** the lead, as if the hold worked
against the AI Caller rather than for it. It has been corrected - a hold is
never used to gate eligibility. The timestamp is instead carried into the call
context (`LeadCallContext.callerHoldUntil`) for a future caller to use when
timing an attempt. We still cannot confirm that this specific column is how the
hold is exposed via the API - it has been `null` in every row ever sampled -
but the corrected logic no longer depends on that guess being right: a wrong
mapping can only leave the context field empty, never cause a wrong skip or a
wrong call.

## The five outstanding decisions

Reviewed against the documented AI Caller workflow, the Lead API
documentation, and the product owner's direct clarifications. Read-only GETs
only; nothing was written.

### Decision 1 — the 10-minute caller hold

| Item                                                                                                                               | Classification                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A hold exists, reserves the lead for the AI Caller against human CRM claiming, ends on a reported attempt or expires automatically | **Confirmed directly by the product owner**                                                                                       |
| Hold duration is 10 minutes (current test setting)                                                                                 | **Confirmed directly**                                                                                                            |
| `caller_hold_until` is the API field that implements this hold                                                                     | **Still an assumption** — the column has been `null` in every row ever sampled, so its populated behavior has never been observed |

**This was a real bug, now fixed.** The previous version treated a future
`caller_hold_until` as a reason to **skip** the lead — backwards, since the
hold works _for_ the AI Caller, not against it. `evaluateListEligibility` no
longer gates on this field at all; the value is only surfaced to
`LeadCallContext.callerHoldUntil` for a future caller to use when timing an
attempt. No CRM endpoint to set, extend, or release the hold has been invented
or implemented — we only ever read whatever the API returns.

### Decision 2 — what counts as a new lead

| Item                                                                                 | Classification                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `created_at` exists on every row and separates creation from later edits             | **Confirmed by live data**                                                                                                                                               |
| `updated_at`-only changes (notes, assignments, corrections) must not cause a re-call | **Confirmed by the Lead API doc**, enforced structurally                                                                                                                 |
| A fixed age window (e.g. "no older than 60 minutes")                                 | **Removed** — not supported by the documented workflow, and actively wrong: a poller that fell behind would wrongly skip a genuinely new lead once it crossed the cutoff |

**What actually prevents an old lead from being treated as new** is structural,
not a timestamp comparison: `recordLeadDecision` (repository layer) only ever
transitions a lead out of `PENDING` once, and the bootstrap run records
everything present before polling began. `created_at` now only has to exist
and parse — it is a presence check, not an age cutoff. The `poll:leads:preview`
command (added last round) lets you see exactly which leads this produces
without writing anything; see
[Inspecting eligible leads](#inspecting-eligible-leads-without-processing-them).

### Decision 3 — eligibility, statuses, and phone validation

| Item                                                                                                   | Classification                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only `is_lead === true` may be processed                                                               | **Confirmed by the workflow doc**, enforced                                                                                                                             |
| `Unsubscribe`, `Closed`, `Post Trip` block calling                                                     | **Confirmed by the workflow doc**, enforced — and **only these three**                                                                                                  |
| `phone_e164` + `valid === true` is the callable number                                                 | **Confirmed by live data**                                                                                                                                              |
| `phone_raw` / `phone_best` must never be dialled                                                       | **Confirmed by the workflow doc**, enforced                                                                                                                             |
| A `null` status means eligible                                                                         | **Explicitly not assumed** — null only means "not one of the three exclusions," and still has to clear every other gate                                                 |
| `Unsubscribe (M)`, `Deleted`, `Cancelled (NR)`, `Dead Lead`, `Newsletter` equal a documented exclusion | **Confirmed NOT to assume this** — removed from the default blocklist (it previously included `Unsubscribe (M)` and `Deleted`, which were my own unconfirmed additions) |

The default `LEAD_BLOCKED_STATUSES` was narrowed from five entries to exactly
the three the workflow document names. `LEAD_BLOCKED_STATUSES` remains
configurable, so adding any of the others later is a config change.

### Decision 4 — form answers and person history

| Item                                                                                                              | Classification                                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `confirm_trek`, `timing`, `trip_length`, `group_size`, `experience`, `been_before` are the real questionnaire ids | **Confirmed by live data**                       |
| There is no destination, budget, or travel-dates column or question                                               | **Confirmed by live data** — nothing is invented |
| Person history and lead detail are read before context is built                                                   | **Implemented**                                  |

No change needed — this was already correct. Re-verified against both
documents; its tests (20, including 3 new ones for `callerHoldUntil`) pass.

### Decision 5 — assignment, notes, and CRM write behavior

| Item                                                                                                                   | Classification                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Only a plain-text note and a booking-triggered assignment are permitted, ever                                          | **Confirmed by the workflow doc**                                |
| Already-assigned leads keep their agent; unassigned + booked leads get the booking agent; no booking means a note only | **Confirmed by the workflow doc**                                |
| Lead status must never be changed                                                                                      | **Confirmed**, enforced today by having **no write code at all** |
| Canonical `X-Agent-Email` identity for future writes                                                                   | **Confirmed**: `ai-caller@himalayanwonders.com`                  |

No write code exists ([readOnlyGuarantee.test.ts](tests/readOnlyGuarantee.test.ts),
13 tests). The confirmed identity is recorded as a commented, planned Phase 5
variable in `.env.example` (`CRM_AGENT_EMAIL`) — not consumed by any code yet,
since no write path exists to use it.

## Inspecting eligible leads without processing them## Inspecting eligible leads without processing them

```bash
npm run poll:leads:preview
```

Reads the Lead API (read-only GETs), evaluates every row against the same
eligibility rules the real poller uses, and **writes nothing anywhere** — no
cursor, no processing record, no CRM write, no call. It needs no working
database connection, because it never imports either repository.

Defaults to the last 24 hours and 5 pages. Override with:

```bash
npm run poll:leads -- --preview --since=2026-10-10T00:00:00Z --max-pages=20 --check-phone
```

`--check-phone` additionally fetches lead detail for list-level candidates and
applies the phone-verdict check (one extra read per candidate). Output is a
summary (counts by outcome and by reason) followed by one line per lead with
its id, `updated_at`, outcome, and reason — never a name, phone, or email.

**Actually run against the live API in the previous round** (read-only, nothing
written; results predate this round's fix to the hold logic and the removed
age window, so `not_a_new_inquiry` no longer occurs — a lead that produced it
before would now continue past that check):

| Window        | Pages              | Rows | Result                                                            |
| ------------- | ------------------ | ---- | ----------------------------------------------------------------- |
| last 24 hours | 5 (bound reached)  | 1000 | 100% `SKIPPED` / `not_a_lead`                                     |
| last 7 days   | 20 (bound reached) | 4000 | `not_a_lead` 2531, `status_blocked` 439, `not_a_new_inquiry` 1030 |

Zero rows were `ELIGIBLE` (the master switch is off, as required) and zero were
`NEEDS_REVIEW` for a missing field. This round's code changes were not
re-verified against a fresh live run - see the report for what **was** run.

## Remaining questions for David

Resolved this round: the hold's purpose and duration, the "new lead" rule
(no fixed window), the exact three blocked statuses, and the canonical
`X-Agent-Email`. What is left:

1. **Turn on automatic eligibility?** `LEAD_ELIGIBILITY_AUTO_ENABLED` stays
   `false` until you say otherwise.
2. **Should `Newsletter` be blocked?** Most common non-null status (67 of 2400
   rows). Not currently blocked, per your instruction not to add it without
   confirmation.
3. **Is `caller_hold_until` really the hold field?** The business rule you
   confirmed (10-minute hold, reserved for the AI Caller) no longer depends on
   this being right — the value is only passed through as context, never used
   to gate eligibility — but if you can confirm the exact field, it would
   remove the last assumption in this area.
4. **How does a caller attempt end the hold early?** You said "a caller
   attempt ends the hold early... do not invent CRM endpoints or writes to
   manage the hold" — correctly, none exist yet. When Phase 3 implements
   actual calling, it will need to know what ending the hold actually requires
   (an endpoint? automatic on the Retell webhook firing?).

## npm scripts## npm scripts

| Script                          | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| `npm run dev`                   | Development server with reload (`tsx watch`) |
| `npm run typecheck`             | TypeScript type check, no emit               |
| `npm run build`                 | Production build to `dist/`                  |
| `npm start`                     | Run the production build                     |
| `npm run lint`                  | ESLint                                       |
| `npm run format:check`          | Prettier check                               |
| `npm run format`                | Prettier write                               |
| `npm test`                      | Unit + integration tests (Vitest)            |
| `npm run test:coverage`         | Tests with coverage                          |
| `npm run prisma:validate`       | Validate `schema.prisma`                     |
| `npm run prisma:generate`       | Generate the Prisma client                   |
| `npm run prisma:migrate:status` | Show migration state against the DB          |
| `npm run prisma:migrate:deploy` | Apply pending migrations                     |

## Testing

```bash
npm test
```

All external systems are mocked. **No test makes a real outbound call, a real
CRM write, a real Lead API request, or a real database connection.** Coverage
includes:

- liveness endpoint, including behaviour while the database is down
- readiness endpoint, both reachable and unreachable, and that failures leak
  no connection details
- environment validation: defaults, coercion, every failure mode, and that
  invalid values are never echoed
- central error handling: `AppError`, Zod errors, malformed JSON, oversized
  bodies, unknown routes, and suppression of unexpected error details
- lead-processing repository: idempotent record creation, atomic
  version-guarded claiming, concurrent-claim races, and the refusal to
  auto-requeue a lead in the `CALLING` state
- graceful shutdown: ordering, idempotency, failure paths, and the force-exit
  timeout
- Lead API client: auth header presence, key never appearing in errors, URL
  encoding of lead ids and person keys, `since`/`cursor`/`limit` as separate
  parameters, malformed JSON, ambiguous and malformed page shapes, 401/403/404
  not retried, 429/5xx/network retried within budget, `Retry-After` honoured,
  and timeouts
- polling: pagination via `nextCursor`, cursor advancing only after a page is
  recorded, no advance on mid-page failure, per-page progress retained on a
  later failure, watermark never rewinding, non-advancing cursor rejected, page
  bound respected
- eligibility: new vs changed inquiries, the newness window boundary, bootstrap
  protection, the master safety switch, `is_lead`, `is_deleted`, blocked
  statuses, and absent fields deferring to review
- phone verdicts: valid, invalid, and unreadable shapes, and that an unreadable
  verdict never yields a call
- duplicate prevention: the same lead across two pages and across two polling
  cycles, and concurrent decision attempts
- call context: corrections preferred over captured values, excluded contact and
  attribution columns, and logs carrying no personal data
- a static scan asserting no `POST`/`PUT`/`PATCH`/`DELETE`, no write endpoints,
  no agent headers, and no Retell or Calendly code anywhere in `src/`

## Production build

```bash
npm run build
npm start
```

## Verification status

Everything below was run in this repository on Node 22.14.0.

| Check                           | Result                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`                   | ✅ 377 packages                                                                                                                                           |
| `npm run typecheck`             | ✅ clean                                                                                                                                                  |
| `npm run lint`                  | ✅ clean                                                                                                                                                  |
| `npm run format:check`          | ✅ clean                                                                                                                                                  |
| `npm test`                      | ✅ **220 tests, 12 files, all passing**                                                                                                                   |
| `npm run build`                 | ✅ compiles to `dist/`                                                                                                                                    |
| `npm run prisma:validate`       | ✅ schema is valid                                                                                                                                        |
| `npm run prisma:generate`       | ✅ client generated                                                                                                                                       |
| Both migrations generated       | ✅ offline, via `prisma migrate diff` — **neither applied**                                                                                               |
| Phase 2 migration is additive   | ✅ verified: only `ADD VALUE` / `ADD COLUMN`, no drops                                                                                                    |
| Initial migration unchanged     | ✅ byte-identical after regeneration                                                                                                                      |
| Lead API client over real HTTP  | ✅ against a local mock server: header sent on every request, URL encoding correct, `nextCursor` pagination followed, 404 not retried, all requests `GET` |
| Server boots without an API key | ✅ `/health` returns 200 with `LEAD_API_KEY_CALLER` empty                                                                                                 |
| Poll command without a key      | ✅ exits with a clear message naming the variable, never its value                                                                                        |
| Health endpoints                | ✅ `/health` 200, `/health/ready` 503 without a DB, 404 JSON shape correct                                                                                |

### Not verified

- **No full poll has been run.** Only read-only GETs were issued to confirm the
  contract; `npm run poll:leads` has never been executed, because it writes to
  a database that is not configured yet. Automated tests still run entirely
  against mocks and a local mock server — no test touches the real API.
- **No lead has ever been marked `ELIGIBLE`.**
  `LEAD_ELIGIBILITY_AUTO_ENABLED` is `false`.
- **Neither migration has been applied to any database.** `DATABASE_URL` in
  `.env` still contains the placeholder password, so no connection was verified
  and nothing was run against a database.
- **Runtime queries against real PostgreSQL.** Repository and polling logic is
  covered by unit tests with a mocked Prisma client; it has not executed real
  SQL.
- **Signal-based graceful shutdown end-to-end.** Git Bash on Windows cannot
  deliver `SIGTERM`/`SIGINT` to a native Node process (verified — even a trivial
  handler never fires). The shutdown logic itself is unit tested and works
  normally on Linux and in containers.

## Security notes

- No real credentials exist anywhere in this repository. `.env.example`
  contains placeholders only; `.env` is gitignored.
- The logger redacts authorization headers, cookies, `X-Lead-API-Key`, provider
  keys, tokens, and personal fields (`email`, `phone`, `phoneNumber`).
- Request and response **bodies are never logged** — they can carry lead
  personal data and provider payloads.
- Health probes are high-frequency and low-signal, so they are excluded from
  access logs.
- Errors stored in `lastError` pass through `sanitizeErrorMessage()`, which
  strips credentials from URLs, redacts key-like values, and truncates.
- CORS is closed by default and refuses a `*` allowlist.
- Trust proxy is set to exactly one hop, not blanket trust of forwarded headers.

## Implementation phases

| Phase | Scope                                                                              | Status      |
| ----- | ---------------------------------------------------------------------------------- | ----------- |
| **1** | Foundation: config, logging, Prisma, models, health, errors, tests                 | **done**    |
| **2** | Lead API: read-only client, incremental polling, durable cursor, eligibility       | **done**    |
| 3     | Retell: initiate calls, map call ids, authenticated idempotent webhooks            | not started |
| 4     | Calendly: verify account, availability, booking, agent routing                     | not started |
| 5     | CRM workflow: one note per call, assignment workflow, never change status          | not started |
| 6     | Hardening: concurrency tests, rate limits, secrets, monitoring, backups, retention | not started |

Phases 3-6 are a plan, not work in progress. Nothing in them is implemented and
no provider contract has been assumed.

**This codebase cannot place a phone call.** There is no Retell dependency, no
telephony code, and a test asserts that no Retell or Calendly reference exists
in `src/`.
