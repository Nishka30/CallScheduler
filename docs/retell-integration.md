# Retell Integration (Phase 3)

> Status: **outbound client implemented and tested with mocked requests; calling
> stays disabled by default.** The `POST /v2/create-phone-call` client is built
> and verified against Retell's official OpenAPI spec (2026-10-15). It is gated
> behind `RETELL_CALLING_ENABLED` (default `false`), which is enforced **before
> any network request**, so no real call can be placed. The webhook ingress and
> the provider-result → enum mapping remain pending on details only David /
> Retell can confirm, and are marked _CONFIRM_.
>
> Nothing here enables automated processing (`LEAD_ELIGIBILITY_AUTO_ENABLED`
> stays `false`), writes to the CRM, applies a migration, or wires the client
> into polling.

## 0. Verified contract (official Retell OpenAPI spec, 2026-10-15)

| Fact                 | Value                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Endpoint             | `POST /v2/create-phone-call`                                                                         |
| Base URL             | `https://api.retellai.com`                                                                           |
| Auth header          | `Authorization: Bearer <RETELL_API_KEY>` (spec: `scheme: bearer`, "format is 'Bearer YOUR_API_KEY'") |
| Required body        | `from_number`, `to_number` (both E.164)                                                              |
| Optional body used   | `override_agent_id`, `idempotency_key`, `metadata`, `retell_llm_dynamic_variables`                   |
| Response (201)       | always `call_id`, `agent_id`, `call_status`, `call_type`, `from_number`, `to_number`, `direction`    |
| `call_status` values | `registered`, `not_connected`, `ongoing`, `ended`, `error`                                           |

The client reads only `call_id` (required — stored as `CallRecord.retellCallId`),
`agent_id` and `call_status` from the response; everything else is kept via
`.passthrough()` without being interpreted. **Not retried:** creating a call is
not idempotent at the transport level, so a timeout/5xx after the request left
the process may mean the call was placed — the client raises an `uncertain`
error for reconciliation instead of redialling.

## 1. Safety posture and the one guard that gates this work

The repository enforces "no Retell integration yet" with a test, not just a
convention: [`tests/readOnlyGuarantee.test.ts`](../tests/readOnlyGuarantee.test.ts)
scans `src/` and **fails** if it finds `RETELL_API_KEY`, `api.retellai`, or a
`retell.com` / `retell.io` reference, or any `POST`/`PUT`/`PATCH`/`DELETE`
request. Two consequences:

- Adding the Retell **env vars** or an outbound **client** to `src/` is a
  deliberate act that flips this guard. It must be done together with updating
  the guard (narrowing it to "no CRM writes" rather than "no Retell at all"), so
  the relaxation is explicit and reviewed — not silent.
- `CallRecord.retellCallId` (already in the schema) does **not** trip the guard,
  so our own call-record bookkeeping can be built now without touching it.

Automated processing stays disabled: `LEAD_ELIGIBILITY_AUTO_ENABLED=false`, and
the Retell call step will sit behind its own explicit enable flag as well (see
§3).

## 2. Integration points (exact, against today's code)

| Concern                       | Where it plugs in                                                                                                                                                                                                                                              | Pattern to mirror                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound Retell client        | new `src/integrations/retell/` (client.ts, schemas.ts, errors.ts)                                                                                                                                                                                              | [`src/integrations/leadApi/`](../src/integrations/leadApi/) — small typed client, Zod-defended parsing, typed error with `permanent`/`retryable`, bounded retry/backoff, key attached only in the request header and never logged |
| Call context → request        | [`buildLeadCallContext()`](../src/services/leadContext.service.ts) already produces `LeadCallContext` (validated E.164 phone, name, 6 questionnaire answers, free text, condensed history). A mapper turns it into Retell's request shape                      | `describeContextForLog()` already proves the fields exist                                                                                                                                                                         |
| Deciding a lead may be called | [`leadEligibility.service.ts`](../src/services/leadEligibility.service.ts) (unchanged) **and** [`callWindow.service.ts`](../src/services/callWindow.service.ts) `isHoldActive()` — both must pass, re-evaluated against **fresh** detail right before dialling | `resolveWithContext()` in [`leadPolling.service.ts`](../src/services/leadPolling.service.ts)                                                                                                                                      |
| Claiming a lead for a call    | [`claimLeadForProcessing()`](../src/repositories/leadProcessing.repository.ts) → `PROCESSING`; a new transition to `CALLING` guards the outbound step                                                                                                          | version-guarded conditional update already there                                                                                                                                                                                  |
| Duplicate-call prevention     | [`callRecord.repository.ts`](../src/repositories/callRecord.repository.ts) `recordCallAttempt()` (refuses a second attempt while one is unresolved) + the `CALLING` claim                                                                                      | already implemented last round                                                                                                                                                                                                    |
| Recording the result          | `CallRecord` row: `retellCallId` (unique, for idempotent webhooks), `status` (`CallStatus`), `outcome` (`CallOutcome`), `summary`, `startedAt`/`endedAt`                                                                                                       | model already exists; lifecycle writers are the safe-now work (§6)                                                                                                                                                                |
| Webhook ingress               | new `src/routes/retell.routes.ts` mounted in [`routes/index.ts`](../src/routes/index.ts) (the comment there already reserves the slot)                                                                                                                         | `health.routes.ts`; must be **authenticated** before it is added                                                                                                                                                                  |
| Config                        | `src/config/env.ts` (`RETELL_*`), placeholders already commented in [`.env.example`](../.env.example)                                                                                                                                                          | `LEAD_API_KEY_CALLER` + `requireLeadApiKey()`                                                                                                                                                                                     |

## 3. Required environment variables

Placeholders already exist, commented, in `.env.example`. When the client is
built they move into `env.ts` as `optionalString()` (so the server still boots
without them, exactly like `LEAD_API_KEY_CALLER`) plus a single
`requireRetellConfig()` enforcement point.

| Variable                 | Required to call | Purpose                                              | Notes                                                                                         |
| ------------------------ | ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `RETELL_API_KEY`         | yes              | Bearer/API credential for the Retell API             | secret; never logged. _CONFIRM_ header/scheme                                                 |
| `RETELL_AGENT_ID`        | yes              | Which configured Retell agent/script places the call | _CONFIRM_ whether the agent + script already exist or must be built                           |
| `RETELL_FROM_NUMBER`     | likely           | Caller ID / registered outbound number               | _CONFIRM_ name and whether per-brand numbers are needed                                       |
| `RETELL_WEBHOOK_SECRET`  | yes (webhook)    | Verify inbound webhook signatures                    | _CONFIRM_ signature scheme (HMAC? header name?)                                               |
| `RETELL_API_BASE_URL`    | no               | Override base URL                                    | default _CONFIRM_                                                                             |
| `RETELL_CALLING_ENABLED` | n/a              | **Master switch for the call step, default `false`** | our own flag, mirrors `LEAD_ELIGIBILITY_AUTO_ENABLED`; no real call until a human turns it on |

## 4. Request contract — call initiation

**What we can supply now** (from `LeadCallContext`, all present and tested):
validated E.164 number, customer name, brand, country/city, free text, the six
confirmed questionnaire answers (trek, group size, trip length, timing,
experience, been-before), plus a non-identifying history summary (prior
inquiries, bookings, calls, current agent/status).

**Resolved (see §0) and implemented in `src/integrations/retell/client.ts`:**

1. ✅ Endpoint + method: `POST /v2/create-phone-call`.
2. ✅ Request schema: `from_number`, `to_number`, `override_agent_id`,
   `idempotency_key`, `metadata`, `retell_llm_dynamic_variables`.
3. ✅ Correlation: the client accepts a `metadata` map (use
   `{ leadId, callRecordId }`) and an `idempotencyKey` (use the local
   `CallRecord.id`, so a duplicate submit cannot double-dial).
4. ✅ Response: `call_id` is required and returned to the caller as the provider
   call id for `CallRecord.retellCallId`.

**Still _CONFIRM_ — the one request detail not safe to assume:**

- The **dynamic-variable names** the "Travel Call Agent" prompt actually reads.
  The client _supports_ `dynamicVariables` as an explicit caller-supplied map
  but injects **none** by default and contains **no** `LeadCallContext` →
  variable mapping, because guessing the agent's prompt variable names would be
  inventing the contract. Once David confirms them, the only new code is a small
  pure mapper from the (stable, tested) `LeadCallContext` fields to those names.

## 5. Webhook contract — call status / completion

**Known / decided now:**

- Mount at `POST /webhooks/retell` via `src/routes/retell.routes.ts`. Express
  `express.json({ limit: '100kb' })` is already configured in
  [`app.ts`](../src/app.ts) and comfortably fits webhook bodies.
- **Must be authenticated** — the router in `routes/index.ts` already states that
  anything exposing or writing lead data must be authenticated first. Signature
  verification must run on the **raw** body, so a raw-body capture for this route
  is required (the global JSON parser alone is not enough for HMAC).
- **Idempotent by `retellCallId`.** `CallRecord.retellCallId` is already unique,
  so a redelivered event resolves to the same row instead of creating a second.
- The sink is provider-neutral (§6): the route verifies + parses, then calls the
  lifecycle writer. No business logic in the HTTP layer.

**Must be confirmed before the handler is written (_CONFIRM_):**

1. Signature/auth scheme: header name, algorithm, and what is signed.
2. Event names and payload shape (one "call_ended" event? separate
   started/ended/analyzed events?).
3. Where in the payload the provider call id, call status, disconnection reason,
   and any summary/analysis live.
4. Retry/delivery semantics (at-least-once assumed; idempotency already covers
   it).

## 6. How outcomes map to the existing call-recording flow

The `CallRecord` lifecycle is **provider-neutral** and can be built now — it only
writes our own table. The Retell-vocabulary → our-enum translation is the one
piece that needs David and is **not** invented.

### Safe to build now (our own DB; no Retell contract involved)

Extend [`callRecord.repository.ts`](../src/repositories/callRecord.repository.ts):

```
attachProviderCallId(callRecordId, providerCallId)
  // PENDING -> INITIATED, sets retellCallId; unique constraint = idempotent

recordCallResult(providerCallId, { status, outcome?, summary?, startedAt?, endedAt? })
  // keyed on the unique retellCallId; last-writer terminal update; a redelivered
  // webhook is a no-op. `summary` is a short agent summary, never a transcript.
```

Target enums already exist in the schema:

- `CallStatus`: PENDING, INITIATED, IN_PROGRESS, COMPLETED, FAILED, NO_ANSWER,
  BUSY, CANCELED, UNKNOWN
- `CallOutcome`: INTERESTED, NOT_INTERESTED, APPOINTMENT_BOOKED,
  CALLBACK_REQUESTED, VOICEMAIL, WRONG_NUMBER, DO_NOT_CONTACT, NOT_REACHED,
  UNKNOWN

### Blocked on David — the translation table (_CONFIRM_)

A pure `mapRetellResult(payload) -> { status, outcome }` function is the natural
home, but its contents require Retell's actual values. Shape (values are
illustrative placeholders, **not** confirmed, default must be `UNKNOWN`):

| Retell signal (_CONFIRM_ exact values) | `CallStatus`     | `CallOutcome`                               |
| -------------------------------------- | ---------------- | ------------------------------------------- |
| call ended, user engaged               | COMPLETED        | INTERESTED / NOT_INTERESTED (from analysis) |
| booking captured                       | COMPLETED        | APPOINTMENT_BOOKED                          |
| voicemail reached                      | COMPLETED        | VOICEMAIL                                   |
| no answer / busy                       | NO_ANSWER / BUSY | NOT_REACHED                                 |
| wrong/invalid number                   | FAILED           | WRONG_NUMBER                                |
| anything unrecognised                  | UNKNOWN          | UNKNOWN                                     |

The default-to-`UNKNOWN` rule means an unexpected value can only ever leave a
call under-classified for human review — never mislabelled as a success.

## 7. End-to-end flow once unblocked (no new concurrency primitives needed)

```
eligible lead (list + phone checks pass)
  -> re-fetch fresh detail; isHoldActive() == true        [callWindow.service]   implemented
  -> markCalling: PROCESSING -> CALLING (version-guarded)  [leadProcessing.repo]  implemented
  -> recordCallAttempt(leadId)  (dup guard)               [callRecord.repo]      implemented
  -> requireRetellCallingEnabled()                        [config/env]           implemented (fails closed)
  -> Retell create-call                                   [retell client]        IMPLEMENTED (mocked-tested)
  -> attachProviderCallId(retellCallId): INITIATED        [callRecord.repo]      implemented
  ...
  POST /webhooks/retell (verify sig, idempotent)          [retell.routes]        *blocked on contract*
  -> recordCallResult(retellCallId, mapRetellResult(...)) [callRecord.repo]      implemented (map = UNKNOWN until confirmed)
  -> completeProcessing(CALLING -> COMPLETED/FAILED)      [leadProcessing.repo]  implemented
```

The Retell create-call client is now implemented and tested with mocked
requests; it fails closed while `RETELL_CALLING_ENABLED` is off. Only the
webhook ingress remains blocked on its contract. Note the client is **not yet
wired into polling** — no code path calls `createPhoneCall()` automatically; it
is invoked only by its tests.

`requeueForRetry()` already refuses to requeue a `CALLING` lead, so an uncertain
in-flight call is never auto-redialled — that safety rule already covers Phase 3.

## 8. Summary — implemented now vs. blocked

**Implemented in this phase** (our own DB / pure logic / config only — no Retell
contract, no real call, no CRM write, no migration):

- `RETELL_CALLING_ENABLED` master switch (default `false`, independent of
  `LEAD_ELIGIBILITY_AUTO_ENABLED`) + `requireRetellCallingEnabled()` enforcement
  point in `config/env.ts`, plus the `.env.example` entry.
- Provider-neutral `CallRecord` lifecycle writers `attachProviderCallId()` and
  `recordCallResult()` in `callRecord.repository.ts` (+ tests).
- `markCalling()` — the version-guarded `PROCESSING -> CALLING` transition in
  `leadProcessing.repository.ts` that rejects conflicting claims (+ tests).
- `mapRetellResult()` in `src/integrations/retell/outcomeMap.ts` — defaults every
  input to `UNKNOWN` until the table is confirmed (+ tests).
- **`RetellClient.createPhoneCall()`** in `src/integrations/retell/client.ts` —
  the outbound call client (client.ts, schemas.ts, errors.ts), verified against
  the official OpenAPI spec, single-shot (never retries), DI-mockable fetch,
  bearer key only in the header and never logged, and all three pre-flight
  guards (switch, config, E.164 destination) enforced before any request
  (+ 28 tests, all mocked).
- `RETELL_API_BASE_URL`, `RETELL_API_KEY`, `RETELL_FROM_NUMBER`,
  `RETELL_AGENT_ID`, `RETELL_AGENT_NAME`, `RETELL_TIMEOUT_MS` in `config/env.ts`
  (secrets optional at startup) + `requireRetellConfig()` enforcement point.

**The read-only guard was narrowed deliberately, not gutted.**
`readOnlyGuarantee.test.ts` now allows exactly one `POST` — the Retell client's
`/v2/create-phone-call` — and still statically proves everything that made it a
_CRM-write_ guarantee: the Lead API client stays GET-only, no CRM write
endpoints or `X-Agent-Email`/`X-Agent-Name` headers, no `lead_status`/
`trip_status` writes, and Calendly stays entirely absent. The Retell client is
asserted to target only the create-call endpoint, never `/api/crm/`.

**Database-level protection still required before real calls.** The partial
unique index on `call_records` (documented in `callRecord.repository.ts`) is
**not** applied — no migration was run. Today duplicate attempts are prevented by
the `CALLING` claim + the unresolved-attempt check in `recordCallAttempt()`. The
index must be applied as the DB-level backstop before `RETELL_CALLING_ENABLED` is
ever turned on.

**Resolved this phase:** base URL, bearer auth scheme, create-call endpoint and
request schema (§0); the agent exists (the manual dashboard test succeeded, and
`RETELL_AGENT_ID` is configured).

**Still blocked on David / Retell (external API details):**

1. The **dynamic-variable names** the Travel Call Agent prompt reads (the one
   remaining request-mapping detail; the client supports them but injects none).
2. Webhook signature scheme, event names, and payload shape — the whole webhook
   ingress waits on this.
3. Retell's status / disconnection / analysis vocabulary → our `CallStatus` /
   `CallOutcome` values (the §6 table); `mapRetellResult()` returns `UNKNOWN`
   until then.
4. **How a caller attempt is reported to end the Lead API hold early** — still
   unnamed in any document (carried over from Phase 2); no endpoint invented.
5. The partial unique index on `call_records` (DB-level dup backstop) must be
   applied as a migration before `RETELL_CALLING_ENABLED` is ever turned on.

## 9. Calendly — deliberately deferred

Kept entirely separate, as instructed. No Calendly code, config, or contract is
touched here. The booking-triggered assignment it feeds (assign the booked agent
only when the lead is unassigned and the booking succeeded) depends on
availability/booking endpoints and account access that have not been provided,
so it waits for its own confirmed contract.
