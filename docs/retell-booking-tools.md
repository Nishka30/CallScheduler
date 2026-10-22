# Retell booking tools — dashboard configuration (prepared, not applied)

> **Preparation only.** Nothing here has been applied to the Retell dashboard, and
> no secret is printed. This documents the exact config for the two custom
> functions that call the implemented backend endpoint
> `POST /webhooks/retell/booking`.

Written for: whoever administers the Retell agent and deploys the backend.

## Backend contract (from the implemented code — not invented)

| Thing              | Value                                                                                                        | Source                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Endpoint           | `POST /webhooks/retell/booking`                                                                              | `src/routes/retell.routes.ts`                                               |
| Operation dispatch | top-level **`name`** field                                                                                   | `retellBookingFunction.service.ts` → `GET_SLOTS_FUNCTION` / `BOOK_FUNCTION` |
| Tool names (exact) | `get_available_slots`, `book_consultation`                                                                   | `functionSchemas.ts`                                                        |
| Lead binding       | server-side via `call.call_id` → our `CallRecord`; **never** from args                                       | `findByRetellCallId`                                                        |
| Auth               | `X-Retell-Signature`, HMAC-SHA256 over raw body, keyed by the **webhook-badged** Retell API key; fail-closed | `webhookVerify.ts`                                                          |

**Both tools share one URL** and are told apart by the `name` Retell includes in the
body. There is **no** operation argument — do not add one.

### Critical dashboard prerequisites

1. **"Payload: args only" must be OFF** for both tools. The handler reads
   `call.call_id` (to bind the lead) and the top-level `name` (to dispatch). The
   "args only" mode sends just the arguments with no `call`/`name` wrapper, which
   this endpoint will reject (it fails closed). Keep the default full payload.
2. The agent's Retell **API key used for signing must be the webhook-badged one**
   — the same key already configured as `RETELL_API_KEY` for the call-lifecycle
   webhook. Verification only works with that key.
3. Do **not** add a `lead_id` parameter. The lead is resolved server-side; any id
   the model emits is ignored.

## Tool 1 — `get_available_slots`

Dashboard fields → Name: `get_available_slots`; URL: `https://<YOUR_PUBLIC_HOST>/webhooks/retell/booking`; Method: POST; Speak during execution: on ("Let me check available times…"); Speak after execution: on; Payload args-only: **off**.

```json
{
  "type": "custom",
  "name": "get_available_slots",
  "description": "Get available consultation times for THIS lead's brand. Call this when the customer wants to book a consultation, after you know their timezone. Do not pick a consultant yourself. Returns time slots to offer the customer.",
  "url": "https://<YOUR_PUBLIC_HOST>/webhooks/retell/booking",
  "speak_during_execution": true,
  "speak_after_execution": true,
  "parameters": {
    "type": "object",
    "properties": {
      "timezone": {
        "type": "string",
        "description": "The customer's IANA timezone, e.g. 'Asia/Kolkata', 'Europe/London', 'America/New_York'. Ask the customer if unknown."
      }
    },
    "required": ["timezone"]
  }
}
```

**Example request Retell sends (default payload):**

```json
{
  "name": "get_available_slots",
  "args": { "timezone": "Asia/Kolkata" },
  "call": {
    "call_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
    "metadata": { "leadId": "f936f37d-8158-4b76-8972-97c72d66c4cc", "callRecordId": "..." }
  }
}
```

**Responses this endpoint returns (HTTP 200):**

```json
{
  "available": true,
  "slots": [
    { "starts_at": "2026-10-25T09:00:00.000Z", "local": "Sun 25 Oct, 2:45 PM" },
    { "starts_at": "2026-10-25T10:00:00.000Z", "local": "Sun 25 Oct, 3:45 PM" }
  ]
}
```

```json
{
  "available": false,
  "reason": "No consultant is currently available to book. Take the customer’s details and let them know a consultant will follow up."
}
```

```json
{ "available": false, "error": "A timezone is required to look up available times." }
```

## Tool 2 — `book_consultation`

Dashboard fields → Name: `book_consultation`; URL: same endpoint; Method: POST; Speak during execution: on ("Let me get that booked…"); Speak after execution: on; Payload args-only: **off**; **Max retries: 0** (booking is not safely auto-retryable — the backend is also idempotent, but leave retries at 0).

```json
{
  "type": "custom",
  "name": "book_consultation",
  "description": "Book the consultation for THIS lead AFTER the customer has confirmed the destination and the chosen time. Only call this once the customer has verbally agreed to a specific slot returned by get_available_slots. Returns whether the booking succeeded.",
  "url": "https://<YOUR_PUBLIC_HOST>/webhooks/retell/booking",
  "speak_during_execution": true,
  "speak_after_execution": true,
  "parameters": {
    "type": "object",
    "properties": {
      "timezone": {
        "type": "string",
        "description": "The customer's IANA timezone (same one used for get_available_slots)."
      },
      "starts_at": {
        "type": "string",
        "description": "The chosen slot's starts_at value, copied EXACTLY from a get_available_slots result (ISO-8601 UTC, e.g. '2026-10-25T09:00:00.000Z')."
      },
      "confirmed": {
        "type": "boolean",
        "description": "Set to true ONLY after you have summarised the destination and time back to the customer and they explicitly agreed. If not confirmed, do not call this tool."
      },
      "confirmed_destination": {
        "type": "string",
        "description": "The destination the customer confirmed on this call (e.g. 'Nepal'). Required."
      },
      "meeting_type": {
        "type": "string",
        "enum": ["phone", "whatsapp", "video"],
        "description": "Consultation type. Defaults to phone if omitted."
      },
      "preferred_trek": { "type": "string", "description": "Trek/region, if confirmed." },
      "trip_duration": { "type": "string", "description": "How long the trip is, if known." },
      "group_size": { "type": "string", "description": "Number travelling, if known." },
      "travel_timing": { "type": "string", "description": "When they want to travel, if known." },
      "special_requirements": {
        "type": "string",
        "description": "Any specific requirement the customer stated."
      },
      "destination_changed_from": {
        "type": "string",
        "description": "The ORIGINAL enquiry destination, ONLY if the customer confirmed changing to a different destination on this call. Omit if the destination is unchanged."
      }
    },
    "required": ["timezone", "starts_at", "confirmed", "confirmed_destination"]
  }
}
```

**Example request Retell sends:**

```json
{
  "name": "book_consultation",
  "args": {
    "timezone": "Asia/Kolkata",
    "starts_at": "2026-10-25T09:00:00.000Z",
    "confirmed": true,
    "confirmed_destination": "Nepal",
    "preferred_trek": "Everest region",
    "trip_duration": "8–11 days"
  },
  "call": { "call_id": "Jabr9TX...", "metadata": { "leadId": "f936f37d-..." } }
}
```

**Responses this endpoint returns (HTTP 200):**

```json
{ "booked": true, "appointment_id": "appt_123", "consultant": "Raine" }
```

```json
{
  "booked": true,
  "already_booked": true,
  "appointment_id": "appt_123",
  "starts_at": "2026-10-25T09:00:00.000Z"
}
```

```json
{
  "booked": false,
  "reason": "That time is no longer available. Offer the customer another time and try again."
}
```

## How the agent should interpret outcomes

| Tool result                                   | Meaning                                    | Agent should                                                                                                     |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `available: true, slots:[…]`                  | Times to offer                             | Read the `local` times to the customer and ask which suits.                                                      |
| `available: false` (reason)                   | No bookable consultant now                 | Take the customer's details; say a consultant will follow up. Do not promise a time.                             |
| `available: false` (error)                    | Missing info (e.g. timezone)               | Ask the customer for the missing detail and retry.                                                               |
| `booked: true`                                | Booked                                     | Confirm to the customer; name the `consultant` if given.                                                         |
| `booked: true, already_booked: true`          | A booking already exists                   | Confirm the existing booking; do **not** book again.                                                             |
| `booked: false` + "another time"              | Slot gone                                  | Call `get_available_slots` again and offer a new time.                                                           |
| `booked: false` + "being finalised / shortly" | **Uncertain** upstream result              | Tell the customer it is being finalised and they'll get confirmation; **do not** call `book_consultation` again. |
| `booked: false` + "follow up / details"       | Can't book now (no consultant / temporary) | Take the customer's details for follow-up.                                                                       |

(HTTP non-2xx — 401/403/400/503 — only occur on auth/binding failures, which should
not happen for a correctly configured, signed call; the agent would see a generic
tool error.)

## Authentication — CONFIRMED

Retell's custom-function docs confirm tool calls are signed with the **same**
scheme as webhooks: an `X-Retell-Signature` header carrying an HMAC-SHA256 of the
**raw request body**, verified with the **webhook-badged** Retell API key. Our
endpoint reuses the existing verifier (`verifyRetellSignature`) and fails closed
(401) on a missing/invalid signature, 503 if no key is configured.

- **No separate shared secret is required** — the signature is sufficient. We rely
  on the already-configured `RETELL_API_KEY` (which must be the webhook-badged key).
- If a future Retell change meant tool calls were **not** signed, this endpoint
  would keep rejecting them (safe) rather than accepting unauthenticated requests;
  the fix would then be a dashboard-configured secret header checked here — never a
  fallback to trusting unsigned requests.
- Sources: Retell custom-function docs and webhook signature docs (links below).

## Public URL / deployment — Retell calls from its cloud

Retell reaches the endpoint over the public internet, so **localhost does not
work**. Set the tool `url` to your deployed HTTPS host:

- **Production:** deploy the backend behind HTTPS and use
  `https://<your-domain>/webhooks/retell/booking`. Security is HTTPS + the
  signature verification already enforced; no extra auth header needed.
- **Testing:** expose local `:3000` with a tunnel (e.g. `ngrok http 3000` or
  `cloudflared`) and use the tunnel's `https://…/webhooks/retell/booking` URL. The
  tunnel URL changes per session — update the tool URL accordingly. Never point
  Retell at `http://localhost`.

## Local server & HTTPS tunnel runbook (testing)

For a test, Retell must reach the local endpoint over public HTTPS. This exposes
`http://localhost:3000` through a temporary tunnel; TLS is terminated at the
tunnel and the **raw body is forwarded unchanged**, so signature verification
keeps working.

### Verified local server facts

| Item          | Value (verified)                                                           |
| ------------- | -------------------------------------------------------------------------- |
| Entry point   | `src/server.ts` → `createApp()`; logs "ai-caller server listening"         |
| Start         | `npm run dev` (`tsx watch src/server.ts`), or `npm run build && npm start` |
| Port          | `3000` (`.env PORT=3000`; `env.PORT` default 3000)                         |
| Health        | `GET /health` (200 liveness), `GET /health/ready` (200 + DB check)         |
| Booking route | `POST /webhooks/retell/booking` — raw body, `X-Retell-Signature` verified  |
| Proxy         | `app.set('trust proxy', 1)` — correct client IP behind a tunnel            |

### 1. Start (or reuse) the local server

```bash
npm run dev            # http://localhost:3000, reads .env (both switches stay false)
```

Smoke-test locally first:

```bash
curl http://localhost:3000/health                                   # {"status":"ok",...}
curl -X POST http://localhost:3000/webhooks/retell/booking -d '{}'  # 401 invalid signature
```

### 2. Open a temporary HTTPS tunnel

A tunnel is a standalone binary, **not** an npm project dependency — installing
one does not touch this repo. Use ONE of:

- **Cloudflare Quick Tunnel (recommended):** no account, ephemeral, nothing
  persisted.
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
  It prints a public `https://<random>.trycloudflare.com` URL.
- **ngrok (alternative):** needs a free authtoken once.
  ```bash
  ngrok http 3000
  ```
  It prints a public `https://<id>.ngrok-free.app` URL.

Your booking endpoint is then `https://<public-url>/webhooks/retell/booking`.

### 3. Verify the public URL reaches THIS server and stays protected

```bash
curl https://<public-url>/health
# → same {"status":"ok","service":"ai-caller",...}  ⇒ it reaches this local server

curl -X POST https://<public-url>/webhooks/retell/booking -d '{}'
# → 401 {"error":"invalid signature"}  ⇒ unsigned requests are rejected through the tunnel
```

Both probes 401/their result **before** any lead lookup or CRM call, so they never
touch the CRM. A `200` only ever comes from a correctly Retell-signed request. Do
**not** send a real signed `book_consultation` here — that belongs to the gated
end-to-end test, not setup.

### 4. Keep both safety switches OFF throughout

- They are already `false` in `.env`; starting the server/tunnel changes nothing.
- Do **not** pass env overrides on the command line (no
  `RETELL_CALLING_ENABLED=true npm run dev`).
- Re-check anytime:
  ```bash
  grep -E '^(RETELL_CALLING_ENABLED|LEAD_ELIGIBILITY_AUTO_ENABLED)=' .env
  # both must read =false
  ```
- The booking endpoint is independent of `RETELL_CALLING_ENABLED` (that gates
  outbound _calling_, not booking); a live booking still cannot write while the
  Lead API `appointments` scope is disabled (403). So setup + unsigned probes
  carry no CRM-write risk.

### 5. Point the two Retell functions at the tunnel URL

Both functions use the **same** endpoint `https://<public-url>/webhooks/retell/booking`:

- `get_available_slots` — **Payload: args only OFF**.
- `book_consultation` — **Payload: args only OFF**, **Max retries = 0**.

("args only" must be off because the handler needs the `call` object for the
`call.call_id` lead binding; see the tool specs above for the parameter schemas.)

### 6. Tunnel expiry / restart & teardown

- The `trycloudflare.com` / `ngrok-free.app` URL is **ephemeral** — it changes
  every time you restart the tunnel. After any restart, update both Retell
  function URLs to the new value.
- The URL is world-reachable, but signature verification means a leak only yields
  `401`s. Still, do not post it publicly.
- **Stop the tunnel after testing** (Ctrl-C the `cloudflared`/`ngrok` process) so
  the endpoint is no longer publicly exposed.

## Go-live blockers, in order

1. **Deploy / expose a public HTTPS URL** for `POST /webhooks/retell/booking`
   (production host or a tunnel for testing). Retell cannot reach localhost.
2. **Confirm `RETELL_API_KEY` is the webhook-badged key** (already required for the
   existing call-lifecycle webhook).
3. **Add both custom functions in the Retell dashboard** with the exact names, the
   public URL, parameter schemas above, **"Payload: args only" OFF**, and
   (for `book_consultation`) max retries 0. Paste the updated agent prompt from
   `docs/retell-agent-prompt.md`. Publish the agent. _(Dashboard step — not done here.)_
4. **Enable the Lead API write scope** `notes,assignment,appointments` (David).
   Until then `book_consultation` returns `booked:false` ("temporarily
   unavailable") because the upstream `POST /appointments/team` is 403.
5. **`appointment_records` migration — APPLIED** to the local `ai_caller` DB on
   2026-10-21 (`20261020000000_appointment_records`). The booking persistence and
   the duplicate-booking pre-check (`findLatestAppointmentForLead`) now have their
   table. No longer a blocker for local testing.
6. **Run one end-to-end controlled test** on a fresh HW lead inside its hold window
   (per the single-lead test procedure), then revert the switches.

Steps 1–3 make the tool reachable and authenticated; 4–5 make a booking actually
succeed and persist; 6 validates. Order matters: do 1→2→3, then 4→5, then 6.
