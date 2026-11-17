# Retell Travel Call Agent — Read-Only Inspection

**Generated:** 2026-11-17 · **Access:** Retell REST API, read-only (GET / list only — no create/update/publish/delete) · **Secrets:** API key never printed; redacted in all files.

> **How this was gathered:** No Retell MCP server is connected to this session, and one cannot be installed in a non-interactive session. Data was pulled directly from the **Retell REST API** (`api.retellai.com`) using the key from your screenshot. The legacy list endpoints are now deprecated (mid-2026), so calls/agents/phone-numbers were fetched via the new `v2`/`v3` endpoints.

Raw machine-readable export: [`retell-agent-export.json`](./retell-agent-export.json) (287 KB — full agent, full conversation flow incl. 29 KB global prompt, both tool schemas, versions, and the full booking call). Plain transcript: [`booking-call-transcript.txt`](./booking-call-transcript.txt).

---

## TL;DR — why the booking failed

The agent called `book_consultation` with **`meeting_type: "travel consultation"`**, which is **not an allowed value**. The tool schema requires `meeting_type` to be exactly one of **`phone`, `whatsapp`, `video`** (and it is a **required** field). The booking backend rejected it: `{"booked": false, "reason": "That consultation type is not supported."}`.

**It was not** a timezone, date-interpretation, slot-availability, or `starts_at` problem — those were all correct. The underlying cause is a **flow ↔ tool contract gap**: the conversation flow **never collects or sets a meeting type** anywhere (no node, no global-prompt step, and the "Confirm Consultation" node doesn't pass it), yet `book_consultation` requires it — so the model invented an out-of-enum value.

---

## 1. AGENT

| Field | Value |
|---|---|
| Agent name | **Travel Call Agent** |
| Agent ID | `agent_e3152e8046a938387ba7a52cc1` |
| Channel | `voice` |
| Version (live) | **0** |
| Published? | **`is_published: false`** — nothing is published; live calls run v0 |
| Response engine | **`conversation-flow`** (not a Retell LLM) |
| Conversation flow ID | `conversation_flow_68e14abb3d41` (version 0) |
| LLM ID | **N/A** — uses a Conversation Flow, not a Retell LLM |
| Flow model | `gpt-5.6-terra` (cascading; `high_priority:false`, `ultrafast:false`) |
| Model temperature | not set (field absent) |
| Voice | `retell-Cimo`; `voice_temperature:1`, `voice_speed:1`, `volume:1`; `enable_expressive_mode:false` |
| Language | `en-US` |
| Interruption sensitivity | **0.9** |
| End call after silence | **30000 ms** |
| Max call duration | **601000 ms** (~10 min) |
| Webhook URL | `https://caller.redpandatours.com/webhooks/retell` |
| Post-call analysis model | `gpt-5.6-terra`; `post_call_analysis_data`: none configured |
| PII config | `mode: post_call`, `categories: []` |
| Data storage | `everything` |
| Agent timezone | `America/Los_Angeles` |
| Voicemail / IVR action | `hangup` / `hangup` |
| DTMF | `allow_user_dtmf: true` |
| Contact memory | `enable_read: true`, `enable_update: false` |
| Last modified | 1793819538928 |

Fields **not present** in the returned config (so unset/default): `responsiveness`, backchannel settings, `reminder_*`, `ambient_sound`, `normalize_for_speech`, `boosted_keywords`, `pronunciation_dictionary`, STT mode.

---

## 2. CONVERSATION FLOW

`conversation_flow_68e14abb3d41`, **version 0**, `is_published: false`, `start_speaker: agent`, **15 nodes**, **2 tools**, `global_prompt` present (full text in the JSON export), **no knowledge bases**.

**Nodes (id · type):**

| Node | Type |
|---|---|
| Welcome Node (`start-node-1791903579650`) | conversation (static greeting) |
| Travel Qualification (`node-1791905088184`) | conversation (prompt) |
| Consultation Requested (`node-1791906234244`) | conversation |
| Confirm Customer Local Time | conversation |
| Get Available Slots (`node-1792684792464`) | **function → `get_available_slots`** |
| Offer Available Slots. (`node-1792687749437`) | conversation (prompt) |
| Confirm Consultation (`node-1792688023469`) | conversation (prompt) |
| Book Consultation (`node-1792687514318`) | **function → `book_consultation`** |
| Booking Confirmed (`node-1792688259042`) | conversation |
| Consultation Declined / Polite Closing / Do Not Contact Closing / End Call … | conversation / end |

**Key finding:** grep across all 15 node instructions for `meeting_type` / `phone` / `whatsapp` / `video` / "contact method" → **0 matches**. The flow never asks the customer *how* they want to meet, and the "Confirm Consultation" node lists exactly what to pass to booking — `starts_at`, `timezone`, `confirmed_destination`, `confirmed` — **but not `meeting_type`**.

---

## 3. LLM CONFIGURATION

**Not applicable** — the agent's response engine is a **Conversation Flow**, so there is no Retell LLM object, no LLM-level general prompt, states, or state transitions. The equivalent config lives in the flow's `global_prompt` + per-node instructions (section 2) and the flow tools (section 4).

---

## 4. TOOLS

Both tools are `type: custom`, `method: POST`, `url: https://caller.redpandatours.com/webhooks/retell/booking`, `timeout_ms: 120000`, `max_retry: 0`, `speak_during_execution: false`, `speak_after_execution: true`.

### GET_AVAILABLE_SLOTS (`tool-1792684751234`)
**Description:** *"Retrieve available consultation times for the current lead in the customer's timezone. Offer only slots returned by the backend. Do not invent availability or choose a consultant; the scheduling system handles assignment."*

| Property | Type | Required | Description |
|---|---|---|---|
| `timezone` | string | **yes** | Customer's confirmed IANA timezone, e.g. `Asia/Kolkata`. |
| `date` | string | no | Preferred date `YYYY-MM-DD` in the customer's timezone (date-first search). |
| `from` | string | no | ISO start of a custom range (use only when `date` not provided). |
| `to` | string | no | ISO end of a custom range (use only when `date` not provided). |

### BOOK_CONSULTATION (`tool-1792687510547`)
**Description:** *"Book the consultation for this lead only after the customer has confirmed the destination and the chosen time. Call this function only after the customer has verbally agreed to a specific slot returned by get_available_slots. Never book without explicit confirmation."*

| Property | Type | Required | Notes |
|---|---|---|---|
| `confirmed` | boolean | **yes** | True only after explicit agreement. |
| `confirmed_destination` | string | **yes** | Destination confirmed in conversation. |
| `starts_at` | string | **yes** | Exact UTC ISO timestamp **copied** from a `get_available_slots` slot. "Do not generate or modify it." |
| `timezone` | string | **yes** | Customer's confirmed IANA timezone. |
| **`meeting_type`** | string **enum** | **yes** | **"Use exactly one of: `phone`, `whatsapp`, `video`."** ← the field that broke the call |
| `destination_changed_from` | string | no | — |
| `group_size` | string | no | — |
| `preferred_trek` | string | no | — |
| `special_requirements` | string | no | — |
| `travel_timing` | string | no | — |
| `trip_duration` | string | no | — |

**No default values** are defined for any property. **How the agent is instructed to use it:** only from the "Book Consultation"/"Confirm Consultation" nodes after explicit confirmation; pass the exact `starts_at`; treat `booked:true` as the only success. **Nothing instructs the agent what `meeting_type` to use or to collect it** — the gap.

---

## 5. CONVERSATION FLOW PATH (the test call)

Observed node transitions (from `transcript_with_tool_calls`):

```
0s  begin → Welcome Node
12s Welcome Node → Travel Qualification  (13s brief interrupt/go-back, re-entered)
44s Travel Qualification → Consultation Requested
49s Consultation Requested → Confirm Customer Local Time
51s Confirm Customer Local Time → Get Available Slots      → get_available_slots #1
60s Get Available Slots → Offer Available Slots.
82s Offer Available Slots. → Get Available Slots            → get_available_slots #2 (Monday)
88s Get Available Slots → Offer Available Slots.
185s Offer Available Slots. → Confirm Consultation          (97s stuck here; Tuesday never queried)
198s Confirm Consultation → Book Consultation               → book_consultation (FAILS)
206s Book Consultation → Booking Confirmed                  (routed to "Confirmed" despite booked:false)
```

---

## 6. RECENT TEST CALL

**Primary call = the booking scenario** `call_132be75743e5fdcb5433f71a167` (the only recent call containing the Mon/Tue/Sat booking flow). The single most-recent call by time (`call_1db2fcecd1ca61dbe71fc4215b4`, 24 s, user hangup, no tool calls) is included in the export but is not the booking test.

| Field | Value |
|---|---|
| Call ID | `call_132be75743e5fdcb5433f71a167` |
| Agent ID / version | `agent_e3152e8046a938387ba7a52cc1` / **0** |
| Type / direction | `phone_call` / `outbound` |
| From → To | `+19789538571` → `+916291764011` |
| Start / End | 2026-11-16T19:16:29.334Z → 19:20:56.226Z (**266.9 s**) |
| Call status | `ended` |
| Disconnection reason | `user_hangup` |
| **call_successful** | **false** |
| **Summary** | *"The caller discussed a solo, adventure-focused Nepal/Everest trip with short hikes and a stated budget of $30,000. They selected a Saturday, November 21 consultation time, but the booking failed because the consultation type was unsupported; no appointment was confirmed."* |
| User sentiment | **Negative** |
| In voicemail | false |
| Custom analysis data | `{}` (none configured) |
| Metadata | `callRecordId: f0ecd7c6-725f-45f1-b251-2f3059ff7524`, `leadId: c8e84f32-63f8-4a6c-88a5-252edac9f406` |
| Collected vars | `current_node: "Booking Confirmed"`, `previous_node: "Book Consultation"` |
| Latency (ms) | LLM p50 527 / p90 620 · e2e p50 935 / p90 1118 · TTS p50 75 · ASR p50 182 |

**Dynamic variables passed into the call:** `customer_name: Nishka`, `customer_timezone: Asia/Calcutta` (source: browser), `customer_local_time: 12:46 AM`, `brand_name: himalayanwonders.com`, `enquired_destination: Nepal`, `preferred_trek: Everest region`, `group_size: Individual`, `travel_experience: A few short hikes`, `travel_timing: Very Soon`, `trip_duration: 5–7 days`.

### TOOL CALLS & RESULTS (complete, in order — 3 calls)

**① `get_available_slots`** — args:
```json
{ "timezone": "Asia/Calcutta" }
```
result:
```json
{ "available": true, "timezone": "Asia/Calcutta", "timezone_label": "India Standard Time",
  "slots": [
    { "starts_at": "2026-11-20T21:00:00.000Z", "local": "Sat, Nov 21, 2026, 2:30 AM" },
    { "starts_at": "2026-11-20T21:15:00.000Z", "local": "Sat, Nov 21, 2026, 2:45 AM" },
    { "starts_at": "2026-11-20T21:30:00.000Z", "local": "Sat, Nov 21, 2026, 3:00 AM" } ] }
```

**② `get_available_slots`** — args (Monday, Nov 23):
```json
{ "date": "2026-11-23", "timezone": "Asia/Calcutta" }
```
result:
```json
{ "available": false, "timezone": "Asia/Calcutta", "timezone_label": "India Standard Time",
  "reason": "No consultant is available on that date. Ask the customer for another day and check that date." }
```

**③ `book_consultation`** — args:
```json
{ "confirmed": true, "confirmed_destination": "Nepal", "group_size": "Individual",
  "meeting_type": "travel consultation",
  "preferred_trek": "Everest region, a few short hikes",
  "special_requirements": "Adventure-focused trip",
  "starts_at": "2026-11-20T21:15:00.000Z", "timezone": "Asia/Calcutta",
  "travel_timing": "Very Soon", "trip_duration": "5–7 days" }
```
result:
```json
{ "booked": false, "reason": "That consultation type is not supported." }
```

---

## 7. Availability/booking behavior — exactly what happened per day

Call date 2026-11-16; Nov 21 = Saturday, Nov 23 = Monday, Nov 24 = Tuesday.

- **Saturday:** `get_available_slots` (call ①) returned 3 real slots, all Sat Nov 21 (2:30/2:45/3:00 AM IST). User initially declined Saturday ("I will be occupied on Saturday").
- **Monday:** user said "Monday" → agent correctly called `get_available_slots` with `date: 2026-11-23` (call ②) → `available:false`. Agent relayed "no slots on Monday." ✅ Correct interpretation and correct tool use.
- **Tuesday:** user agreed to "Tuesday, November 24." The agent **said** it was checking Tuesday, but **no `get_available_slots` tool call was ever fired for Tuesday** — the flow stayed in the "Offer Available Slots." node (no transition back to the function node). Agent stalled: *"I don't have the Tuesday availability result yet."* → **Tuesday was never actually queried.**
- **Final Saturday selection:** user chose 2:45 AM. The agent passed the **correct** `starts_at: 2026-11-20T21:15:00.000Z` (exactly the slot value) — but with **`meeting_type: "travel consultation"`**, which is invalid → `booked:false`. When the user then asked for 3:00 AM, the agent spoke as if rebooking, but **no second `book_consultation` call was fired** (the flow had already moved to "Booking Confirmed"), so the retry never reached the backend.

**Verdict (evidence-based, not guessed):**

| Candidate cause | Ruled in/out | Evidence |
|---|---|---|
| Agent instructions / flow design | **IN (primary + secondary)** | Flow never collects/sets `meeting_type`; after-failure routed to "Booking Confirmed"; Tuesday never re-queried |
| Incorrect `book_consultation` arguments | **IN (direct trigger)** | `meeting_type:"travel consultation"` ∉ enum `[phone, whatsapp, video]` |
| Booking API response | Behaved correctly | Returned a clear rejection of the bad value |
| Timezone | Ruled OUT | `Asia/Calcutta` used consistently; slots correctly converted to IST |
| Date interpretation | Ruled OUT | Mon=Nov23, Sat=Nov21 handled correctly |
| `get_available_slots` response | Ruled OUT | Valid slots returned; correct empty result for Monday |
| Agent misreading slots / `starts_at` | Ruled OUT | Copied the exact `starts_at` of the chosen slot |

**Fix direction (not applied — read-only):** (1) add a flow step that asks the customer for contact method and sets `meeting_type` to `phone`/`whatsapp`/`video` (or default one and make it required in the Confirm Consultation instruction); (2) make the "Offer Available Slots." node actually re-invoke `get_available_slots` when the customer names a new day; (3) on `booked:false`, route back to offer/booking rather than "Booking Confirmed," so a retry re-calls the tool.

---

## 8. VERSIONS

- **Agent:** only **version 0** exists; `is_published: false`. Live calls run v0.
- **Conversation flow:** version 0, `is_published: false`.
- The test call ran `agent_version: 0`.
- **No draft-vs-published divergence exists** — nothing is published, and there is a single version of each. So the live-call configuration is exactly what is shown above.

---

## 9. Account context (read-only)

- **Voice agents (4):** `Travel Call Agent` (this one), `Partner Hub Trust-Gated Receptionist`, `Gated Calls Demo`, `Single-Prompt Agent`.
- **Phone numbers (3):** `+13854815908`, `+19789538571` (the caller ID used), `+16209822458` — none have an `inbound_agent_id`/`outbound_agent_id` bound at the number level.
- **Retell LLMs / knowledge bases:** none relevant (0 KBs; agent uses a flow).

---

## Information I could NOT retrieve through Retell MCP/API

1. **A Retell MCP server** — none is connected to this session, and it can't be added non-interactively. (Worked around using the REST API; everything above came through the API.)
2. **The booking backend's logic** — *why* `"travel consultation"` is unsupported and the full set/behavior it expects lives in **your own service at `caller.redpandatours.com/webhooks/retell/booking`** (CallScheduler / Guided Boost side), **not in Retell**. To see the server-side validation, check that service's `retellBookingFunction` handler — not retrievable via the Retell API.
3. **Retell LLM config** — N/A (this agent uses a Conversation Flow; there is no Retell LLM object).
4. **Legacy list endpoints** (`/list-agents`, `/v2/list-calls`, etc.) are deprecated and return 400; I used the `v2`/`v3` replacements, so no data was lost.
5. **Dashboard-only views** not exposed by the API (e.g. billing/usage analytics, the visual flow canvas) — provide a screenshot if you want those. Nothing required for the booking diagnosis is missing.
6. **Recording audio** — the call object includes signed `recording_url` / `public_log_url` (in the JSON export); I did not download the audio.

*Note: the API key you provided (`key_a39b1…`) authenticated successfully for all read endpoints. Since it was shared in a screenshot, consider rotating it in the Retell dashboard.*
