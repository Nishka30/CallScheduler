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
- Retell outbound call client (`POST /v2/create-phone-call`), gated off by default
- Retell webhook ingress (`POST /webhooks/retell`): signature-verified, idempotent, terminal-safe
- 385 unit/integration tests, ESLint + Prettier

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

Not an eligibility gate: `caller_hold_until`. It is a separate **timing window**
that reserves the lead _for_ the AI Caller, evaluated on its own by
`evaluateCallWindow()`; the eligibility rules above apply regardless of it — see
[below](#caller_hold_until).

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

An **officially supported field** (David's revised contract) on the collector
list and detail reads: an ISO-8601 timestamp or `null`. It reserves a newly
arrived lead **for the AI Caller**, giving it the first opportunity to make
contact before a human sales agent can claim the lead:

- **future timestamp → the hold is active.** The lead is held for the AI Caller,
  so the call workflow may proceed — **subject to every other eligibility check**
  (status, phone validation, assignment, etc.).
- **`null`, past, or unparsable → no active hold.** The lead is available to the
  sales team, so the AI Caller must **not** initiate a (late) call.

This is a **timing window, not an eligibility rule**, and the two are kept
strictly separate. `evaluateCallWindow()` in
[callWindow.service.ts](src/services/callWindow.service.ts) answers only the
go/no-go (`within_hold` vs `no_active_hold`, via `isHoldActive()`); the
eligibility rules continue to apply in full regardless. The value is also carried
into the call context (`LeadCallContext.callerHoldUntil`) for timing an attempt.

**Hold duration is a Lead API setting, `CALLER_HOLD_MINUTES`.** David currently
has it at **0**, so `caller_hold_until` comes back `null` for effectively every
lead (every lead is `no_active_hold`). He will raise it to **10 minutes** when
caller testing begins, at which point a fresh lead carries a ~10-minute future
hold (`within_hold`). The logic handles both with no code change — it only
compares the returned timestamp to the current time.

**One important distinction:** this field reports only whether a hold is active.
It never records whether a lead has already been **called**. Duplicate-call
prevention is tracked separately, keyed by lead id, in
[callRecord.repository.ts](src/repositories/callRecord.repository.ts).

## The outstanding decisions

Reviewed against the documented AI Caller workflow, the Lead API
documentation, and the product owner's direct clarifications. Read-only GETs
only; nothing was written.

### Decision 1 — the caller hold

| Item                                                                                                                 | Classification                                                              |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `caller_hold_until` is an officially supported field (ISO timestamp or `null`) on the list and detail reads          | **Confirmed by the revised contract**                                       |
| Future timestamp = held for the AI Caller (may proceed); `null`/past = available to sales (do not place a late call) | **Confirmed by the revised contract**, implemented in `callWindow.service`  |
| Hold duration is the Lead API's `CALLER_HOLD_MINUTES` — **0 today** (so `null`), **10** when caller testing begins   | **Confirmed directly**; both settings handled with no code change           |
| The caller hold is a timing window, kept separate from the eligibility rules                                         | **Required**, enforced — `evaluateListEligibility` does not read this field |

**Implemented this round.** `evaluateCallWindow()` classifies a lead as
`within_hold` (a future hold) or `no_active_hold` (`null`, past, or unparsable),
and `isHoldActive()` gives the single go/no-go. A `within_hold` lead may proceed
only if it also clears every eligibility check; a `no_active_hold` lead is never
called late. The field is never treated as a "has been called" marker — that is
tracked separately per lead id (see [Decision 6](#decision-6--duplicate-call-prevention)).
No CRM endpoint to set, extend, or release the hold has been invented — we only
ever read whatever the API returns.

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

### Decision 6 — duplicate-call prevention

| Item                                                                   | Classification                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `caller_hold_until` must **not** be used as an "already called" marker | **Required**, enforced — it is only ever read as a timing window                  |
| Call attempts are tracked separately, keyed by lead id                 | **Implemented** in `callRecord.repository.ts` (the `call_records` row)            |
| A second attempt must not open while one is still unresolved           | **Implemented** — `recordCallAttempt()` refuses the duplicate                     |
| A database-level partial unique index for a hard guarantee             | **Applied** — `call_records_active_leadId_key` on `ai_caller`, verified enforcing |

Duplicate calls are prevented by three layers now: the version-guarded claim on
`lead_processing` (only one worker reaches the call step), `recordCallAttempt()`
(no second attempt while one is unresolved), and the **applied** partial unique
index `call_records_active_leadId_key` as the database-level backstop. Because a
partial index can't live in `schema.prisma`, it is applied via
`prisma migrate deploy` (apply-only) — do **not** run `prisma migrate dev`
against `ai_caller`, which would see it as drift.

## Inspecting eligible leads without processing them

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
summary — counts by outcome, by reason, and a dedicated
`newsletterCandidateCount` — followed by one line per lead with its id,
`updated_at`, outcome, reason, and any review `flags` — never a name, phone, or
email.

**Newsletter visibility, not a blocklist addition.** `Newsletter` is the most
common non-null status and was never confirmed as an exclusion, so it is not
blocked. But a `Newsletter` record with `is_lead === true` would otherwise be
indistinguishable from any other pending lead in the summary, so each one is
tagged `flags: ["newsletter_status_is_lead"]` and counted separately. This
changes nothing about its `outcome` or `reason`.

**Run against the live API this round** (read-only, nothing written) to verify
both the hold-logic fix and the Newsletter visibility feature:

| Window       | Pages              | Rows | Result                                                                                                                                    |
| ------------ | ------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| last 7 days  | 20 (bound reached) | 4000 | `not_a_lead` 2531, `awaiting_new_lead_rule_confirmation` **1320**, `status_blocked` **149**                                               |
| last 30 days | 12 (bound reached) | 2400 | `not_a_lead` 2282, `awaiting_new_lead_rule_confirmation` 108, `status_blocked` 10 — **67 of the 108 flagged `newsletter_status_is_lead`** |

Two things this confirms:

- `not_a_new_inquiry` (1030 occurrences before the fix, over the same 7-day
  window) **no longer occurs at all** — those leads now correctly continue to
  `awaiting_new_lead_rule_confirmation` instead of being permanently discarded.
- **67 of 108** leads pending review in the 30-day sample are `Newsletter`
  signups, not travel inquiries — the majority. See
  [docs/architecture.md](docs/architecture.md#an-operational-finding-worth-flagging-now)
  for why this matters before `LEAD_ELIGIBILITY_AUTO_ENABLED` is turned on.

Zero rows were `ELIGIBLE` (the master switch is off, as required).

## Retell integration (outbound calling — disabled by default)

The outbound call client is implemented and tested with mocked requests. **No
real call is placed:** it is gated behind `RETELL_CALLING_ENABLED` (default
`false`), enforced before any network request, and it is **not wired into
polling** — only its tests invoke it. Full detail:
[docs/retell-integration.md](docs/retell-integration.md).

**Verified against Retell's official OpenAPI spec:** `POST /v2/create-phone-call`
on `https://api.retellai.com`, `Authorization: Bearer <RETELL_API_KEY>`, required
`from_number`/`to_number` in E.164, response always carries `call_id`.

### Configuring Retell

| Variable                 | Where to get it                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `RETELL_API_KEY`         | Retell dashboard → **API Keys**. Secret; set it only in local `.env`.                       |
| `RETELL_AGENT_ID`        | Retell dashboard → **Agents** → open "Travel Call Agent"; the id is in the URL / details.   |
| `RETELL_FROM_NUMBER`     | Your purchased Retell number in E.164 (`+19789538571`), configured with the outbound agent. |
| `RETELL_API_BASE_URL`    | `https://api.retellai.com` (default).                                                       |
| `RETELL_AGENT_NAME`      | `Travel Call Agent` — informational only, not sent to the API.                              |
| `RETELL_TIMEOUT_MS`      | Optional; default `15000`.                                                                  |
| `RETELL_CALLING_ENABLED` | **Keep `false`.** The master switch for placing calls.                                      |

The server boots without any Retell value; a call fails clearly (naming the
missing variable, never its value) if config is incomplete.

### Keeping calling disabled during development

Leave `RETELL_CALLING_ENABLED=false` (the default). The client's first action in
`createPhoneCall()` is the switch guard, so with it off the method throws a
`disabled` error and makes **zero** network calls — verified against the real
`.env` config. Tests enable the switch only on an isolated, injected config
object; the global/`.env` switch is never flipped.

### Webhook (`POST /webhooks/retell`)

Implemented and mocked-tested. Verified against Retell's SDK (v6.2.6): the
`x-retell-signature` header has the form `v=<ts>,d=<hexdigest>` and is
**HMAC-SHA256 over `body + timestamp`, keyed by your `RETELL_API_KEY`** — there
is **no separate webhook secret**, and there is a built-in **5-minute replay
window**. Verification runs over the **raw** body (the route is mounted before
the global JSON parser), constant-time, and **fails closed**: missing key → 503,
missing/invalid signature → 401, malformed → 400.

Events (`call_started`, `call_ended`, `call_analyzed`) are matched to a
`CallRecord` by `call_id` and persisted with a **terminal-safe, order-independent,
idempotent** merge: a redelivered or out-of-order event can never downgrade a
terminal status, overwrite a known outcome with `UNKNOWN`, or create a duplicate
record; an unknown `call_id` is acknowledged but never fabricates a lead link.
Set the webhook URL in the Retell dashboard to `https://<host>/webhooks/retell`.

> Because outbound calling is disabled and nothing yet stores a `retellCallId`,
> every delivered webhook currently resolves to "unknown call id" (acknowledged,
> no-op). That is expected until outbound calling is wired.

### What is implemented vs. pending

**Implemented** (all mocked-tested): the `RetellClient`
(`createPhoneCall`, single-shot/never-retried); the config enforcement points
(`requireRetellConfig` / `requireRetellApiKey`); the `CallRecord` lifecycle
writers with duplicate-attempt prevention; the **webhook ingress** (verification

- validation + terminal-safe persistence); a **conservative outcome map**
  (voicemail / no-answer / busy / invalid-number / explicit DNC / callback only —
  completed conversations, `call_successful` and sentiment stay `UNKNOWN`, a
  booking or interest is **never** inferred from a transcript); the
  **database-level partial unique index** `call_records_active_leadId_key`
  (applied to `ai_caller`); and the **end-to-end orchestrator**
  `initiateCallForLead()` — switch/eligibility/phone/hold guards, atomic claim,
  attempt-before-dial, and uncertain-vs-permanent failure handling — which is
  disabled by default and **not wired into polling**.

The orchestrator is now **wired into the poll**: a freshly-`ELIGIBLE` lead is
handed to `initiateCallForLead` only when `RETELL_CALLING_ENABLED` is true (and a
lead only reaches `ELIGIBLE` when `LEAD_ELIGIBILITY_AUTO_ENABLED` is true), so
with both switches off the normal poll path places no call. The agent's two
confirmed dynamic variables (`customer_name`, `brand_name`) are mapped from the
lead context (missing values omitted, nothing else invented).

**Pending:** the business-outcome half of the map (`INTERESTED`/`NOT_INTERESTED`/
`APPOINTMENT_BOOKED`) which needs an authoritative Calendly result; the CRM
note/assignment writes; and Calendly booking. **A live call also needs
`CALLER_HOLD_MINUTES` set non-zero** on the Lead API side — with it at `0`, every
lead's hold is `null`, so the hold gate (correctly) refuses to call. All 2000
recently-sampled leads had `caller_hold_until: null`.

## Remaining questions for David

Resolved: the hold's purpose and the `caller_hold_until` contract (future = held
for the AI Caller; `null`/past = available to sales, do not call late), the
"new lead" rule (no fixed window), the exact three blocked statuses, and the
canonical `X-Agent-Email`.

1. **Turn on automatic eligibility?** `LEAD_ELIGIBILITY_AUTO_ENABLED` stays
   `false` until you say otherwise.
2. **Should `Newsletter` be blocked?** Still not currently blocked, per your
   instruction not to add it without confirmation. Now measured: **67 of 108**
   (62%) of leads pending review in a 30-day sample carry this status — see
   [the operational finding above](#inspecting-eligible-leads-without-processing-them).
3. **When does `CALLER_HOLD_MINUTES` move to 10?** The logic already handles
   both 0 (today, every hold `null`) and 10; this is just a heads-up that
   turning it on is what makes any lead classify as `within_hold`.
4. **How does a caller attempt end the hold early?** No endpoint for this
   exists in either document, and none has been invented, as instructed. Phase
   3 cannot report an attempt without this (a hold otherwise expires on its own
   timer).

## npm scripts

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
| `npm test`                      | ✅ **385 tests, 21 files, all passing**                                                                                                                   |
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

| Phase | Scope                                                                                                                                                                      | Status          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **1** | Foundation: config, logging, Prisma, models, health, errors, tests                                                                                                         | **done**        |
| **2** | Lead API: read-only client, incremental polling, durable cursor, eligibility                                                                                               | **done**        |
| 3     | Retell: outbound client + webhook ingress + end-to-end orchestrator + DB dup-index done (mocked-tested, disabled by default); wiring the orchestrator into polling pending | **in progress** |
| 4     | Calendly: verify account, availability, booking, agent routing                                                                                                             | not started     |
| 5     | CRM workflow: one note per call, assignment workflow, never change status                                                                                                  | not started     |
| 6     | Hardening: concurrency tests, rate limits, secrets, monitoring, backups, retention                                                                                         | not started     |

Phases 3-6 are a plan, not work in progress. Nothing in them is implemented and
no provider contract has been assumed.

**This codebase cannot place a phone call.** There is no Retell dependency, no
telephony code, and a test asserts that no Retell or Calendly reference exists
in `src/`.
