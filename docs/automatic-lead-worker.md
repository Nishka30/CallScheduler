# Automatic lead worker

Written for: whoever deploys and operates the AI caller.

## What it does

When enabled, the backend automatically, on a timer:

1. polls David's Lead API incrementally (brand filtered via `LEAD_TEST_BRAND`/`LEAD_API_BRAND`),
2. ingests each lead and records an eligibility decision durably,
3. for a freshly-**ELIGIBLE** lead, hands it to the call orchestrator — **only when
   `RETELL_CALLING_ENABLED=true`** — which re-validates everything and dials.

No manual `npm run poll:leads` or `npm run call:lead` is needed for normal operation.

## Why it was not automatic before

`runLeadPoll()` already did detect → ingest → classify → gated call in one cycle,
but nothing ran it on a schedule: `src/server.ts` only started the HTTP listener,
and `runLeadPoll()` was invoked solely by the manual CLI. The fix is a background
scheduler (`src/services/leadWorker.service.ts`) around that **existing** cycle —
no second poller or orchestrator was created.

## How to run it (startup / deployment)

Automatic operation is a single flag plus the normal start command:

```bash
# production
LEAD_WORKER_ENABLED=true        # in .env (or the deployment's env)
npm run build && npm start

# development
LEAD_WORKER_ENABLED=true npm run dev   # (or set it in .env)
```

The worker starts inside the server process right after the listener binds, and
is stopped gracefully on SIGTERM/SIGINT (it halts scheduling and awaits any
in-flight cycle before the server and DB close). Starting the server with
`LEAD_WORKER_ENABLED=false` (the default) runs the API only — **no** background
polling, so "server up" never falsely implies "worker active". Check which it is
at `GET /health/worker`.

## Feature flags (responsibilities)

| Flag                            | Controls                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `LEAD_WORKER_ENABLED`           | Whether the background poll loop runs at all. Default `false`.                      |
| `LEAD_ELIGIBILITY_AUTO_ENABLED` | Whether a passing lead becomes `ELIGIBLE` (vs held in `NEEDS_REVIEW`).              |
| `RETELL_CALLING_ENABLED`        | Whether the orchestrator actually DIALS. Enforced in the client too.                |
| `LEAD_REEVAL_ENABLED`           | Whether stuck `NEEDS_REVIEW` leads are automatically re-evaluated. Default `false`. |

Safe combinations:

- Worker on, calling off → leads are ingested and classified; **nothing is dialled**.
- Worker on, auto-eligibility off → nothing even reaches `ELIGIBLE`, so no call is attempted.
- Worker on, both on → eligible leads are dialled automatically.

## Automatic `NEEDS_REVIEW` re-evaluation (bounded + throttled)

A lead can land in `NEEDS_REVIEW` for a transient DATA-availability reason — most
commonly `phone_verdict_unreadable`, because the Lead API populates its phone
verdict asynchronously (~7–10 min after the lead is created). The normal poll
path never revisits such a lead (by design — `recordLeadDecision` only moves a
lead out of `PENDING`). When `LEAD_REEVAL_ENABLED=true`, the worker runs a
**bounded, throttled sweep after each poll cycle** that retries those leads.

How it stays safe and cheap:

- **Reuses the exact logic.** Each retry calls `reevaluateNeedsReviewLead()`,
  which re-runs the same eligibility checks (incl. `LEAD_BLOCKED_STATUSES` — an
  `Unsubscribe` lead resolves to `SKIPPED`, **never promoted or called**), the
  phone verdict, and `RETELL_CALLING_ENABLED`, and applies the result through the
  **version-guarded CAS** that can only move a lead OUT of `NEEDS_REVIEW`.
- **Throttled per lead.** First retry no sooner than `LEAD_REEVAL_RETRY_INTERVAL_MS`
  after the lead's decision; each further retry waits `× LEAD_REEVAL_BACKOFF_FACTOR`.
- **Bounded.** At most `LEAD_REEVAL_MAX_ATTEMPTS` per lead (then left
  `NEEDS_REVIEW`, "exhausted"), at most `LEAD_REEVAL_MAX_PER_CYCLE` Lead API
  re-evaluations per sweep, reading at most `LEAD_REEVAL_BATCH_SIZE` candidate
  rows locally per sweep.
- **In-memory retry state** (per process; no schema change). A restart resets the
  counters for a fresh bounded budget; the CAS guarantees no unsafe/duplicate
  decision regardless, and across replicas each throttles independently while the
  CAS keeps one decision winning.
- **Observability:** each sweep logs a structured summary
  (`considered, notDue, exhausted, attempted, promoted, resolvedSkipped,
stillUnchanged, newlyExhausted, races, errors`); exhaustion logs a per-lead
  warning. A sweep failure is contained — it never fails the poll cycle.

The manual `npm run reevaluate:lead -- <id>` remains for one-off, on-demand
re-evaluation independent of this sweep.

## Reliability & idempotency (where the guarantees live)

- **No overlapping cycles:** the scheduler reschedules only after the current
  cycle settles (self-timer + in-flight guard).
- **Failures don't kill the loop:** a failed cycle is logged (sanitised) and the
  next is delayed with bounded exponential backoff (`LEAD_WORKER_MAX_BACKOFF_MS`).
- **No duplicate calls across restarts/replicas** — enforced at the DATABASE,
  independent of the worker:
  - `recordLeadDecision` transitions a lead out of `PENDING` exactly once (version-guarded);
  - `claimEligibleLead` / `markCalling` are version-guarded compare-and-set;
  - `recordCallAttempt` + the applied unique index `call_records_active_leadId_key`
    make a second active attempt impossible even under a race.
- **Cursor is durable:** `IntegrationCursor` advances only after a page is fully
  recorded, so a restart re-reads at most one page and loses no leads.
- **Uncertain dial results are never auto-retried** (orchestrator leaves the lead
  `CALLING` for reconciliation).
- **Hold respected:** the orchestrator refuses to dial after `caller_hold_until`.
- **Multi-replica polling:** set `LEAD_WORKER_USE_DB_LOCK=true` so a Postgres
  advisory lock lets only one replica poll per cycle (reduces redundant reads).
  Call-uniqueness does not depend on it.

## Observability

`GET /health/worker` returns (no secrets, no PII):

```json
{
  "enabled": true,
  "running": true,
  "polling": false,
  "startedAt": "…",
  "lastPollStartedAt": "…",
  "lastPollFinishedAt": "…",
  "lastPollOk": true,
  "consecutiveErrors": 0,
  "cyclesCompleted": 12,
  "lastSummary": {
    "rowsSeen": 40,
    "decisionsApplied": 3,
    "callsConsidered": 1,
    "callOutcomes": { "call_initiated": 1 }
  },
  "intervalMs": 60000
}
```

Returns `503` when the worker is enabled but not running (e.g. never started), so
a liveness probe can alert. Per-lead decisions (why a lead was skipped/called) are
in the structured poll logs.

## The manual CLIs still exist

`npm run poll:leads` / `npm run poll:leads:preview` / `npm run call:lead -- <id>`
remain for controlled debugging and the single-lead authorized test. They are not
the normal operating path once the worker is enabled.
