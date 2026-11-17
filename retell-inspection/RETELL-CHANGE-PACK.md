# Retell Travel Call Agent — Change Pack (review-only, nothing applied)

**Agent:** Travel Call Agent `agent_e3152e8046a938387ba7a52cc1` · **Flow:** `conversation_flow_68e14abb3d41` (v0, not published) · **Model:** `gpt-5.6-terra` (cascading, standard) · **Based on:** the actual exported config + the Nov 16 test call `call_132be75743e5fdcb5433f71a167`.

Companion files in this folder: **[`global-prompt-REVISED.txt`](./global-prompt-REVISED.txt)** (complete copy-paste global prompt), [`RETELL-INSPECTION-REPORT.md`](./RETELL-INSPECTION-REPORT.md), [`retell-agent-export.json`](./retell-agent-export.json).

> Nothing in Retell has been changed. This is the proposed set of changes for your review.

---

## 1. Current problem summary (from the actual call + config)

| # | Problem | Root cause in the config | Evidence |
|---|---|---|---|
| P1 | **Booking fails every time** with "consultation type is not supported" | Global prompt lists only **"four required arguments"** and marks `meeting_type` **optional** (lines 522–539), but the `book_consultation` schema makes `meeting_type` a **required enum** `["phone","whatsapp","video"]`. No node ever collects it, so the model invents `"travel consultation"`. | Tool call #3: `meeting_type:"travel consultation"` → `{"booked":false,"reason":"That consultation type is not supported."}` |
| P2 | **A requested date is never actually checked** (Tuesday) | "Offer Available Slots." → "Get Available Slots" edge condition is phrased around *"rejected the offered times"*, so when the customer names a new day the model narrates "I'll check Tuesday" but **does not transition / fire the tool**. | Node path stays in "Offer Available Slots." 88s→185s; only 2 `get_available_slots` calls ever fired (none for Nov 24). |
| P3 | **Flow routes to "Booking Confirmed" even on failure; no retry path** | "Book Consultation" has one explicit edge → **Booking Confirmed** with a *catch-all* condition; `else_edge` → Booking Not Confirmed effectively never fires. Both Booking Confirmed and Booking Not Confirmed only edge to **End Call**, so a second booking attempt (3 AM) had nowhere to go — no 2nd `book_consultation` fired. | `collected_dynamic_variables.current_node = "Booking Confirmed"` after `booked:false`; only 1 `book_consultation` invocation in the whole call. |
| P4 | **Robotic / repetitive speech, awkward pauses** | No explicit speaking-style constraints; `interruption_sensitivity: 0.9` (very high) fragments agent turns; the agent narrates "I'm checking…" while no tool runs. | Transcript: "I'm here. I'm checking Tuesday…", "Sorry for the delay…", fragmented "I"/"I'm" lines. |
| P5 | Agent **proposes a specific date** ("Would Tuesday, Nov 24 work?") as if it knows the calendar | STEP 1 lets the model suggest dates; it should ask the customer or check, not imply a day is special. | Transcript. |

**What was already correct (do not "fix"):** timezone handling (Asia/Calcutta used consistently, slots converted correctly), `starts_at` integrity (the exact UTC value from the slot was passed), the Monday check (correctly called `date:2026-11-23` → empty), and the `get_available_slots` responses. Do **not** touch those.

---

## 2. Architecture / flow issues

- The failure branch exists structurally (`else_edge` on both function nodes, plus "Availability Check Issue" and "Booking Not Confirmed" nodes) but is **mis-wired**: the "Book Consultation" explicit edge condition is a multi-paragraph catch-all, so the model always takes the "Booking Confirmed" edge and the `else_edge` is dead.
- There is **no loop back from a failed/again-wanted booking** to availability. Recovery dead-ends at End Call.
- The **"Offer Available Slots." → "Get Available Slots" re-check edge** is too narrowly worded to fire on a plain "let's try Tuesday".
- **No node collects `meeting_type`.**
- Agent-level `interruption_sensitivity 0.9` is aggressive for a consultative call.

---

## 3. GLOBAL PROMPT — complete revised version

**The complete, copy-paste-ready prompt is in [`global-prompt-REVISED.txt`](./global-prompt-REVISED.txt).** It is the full existing prompt with surgical edits — **all existing business rules preserved**. Seven changes were made:

| Edit | Where | Keep / Modify / Add | What changed |
|---|---|---|---|
| R1 | PRIMARY OBJECTIVES | Modify | Added objective 9 "Confirm the customer's preferred consultation method (phone, WhatsApp, or video) before booking"; renumbered. |
| R2 | §4 STEP 7 | **Modify (critical)** | "four required arguments" → **"FIVE required arguments"**; added `meeting_type` (enum `phone`/`whatsapp`/`video`, default `phone`) to **required**; removed it from the "optional" list. This is the P1 fix. |
| R3 | §4 (new STEP 6.5) | Add | "Confirm the preferred consultation method" — ask phone/WhatsApp/video, map answers, default `phone`, never send free text. |
| R4 | §5 safeguards | Modify | Added a bullet requiring `meeting_type` (one of the three; default `phone`). |
| R5 | §4 IF BOOKING SUCCEEDS / FAILS | Modify | Made success mean **`booked === true` only**; failure (`booked:false`/missing) must never be announced as confirmed and must offer a retry with new confirmation. |
| R6 | after CONVERSATION RULES (new section) | Add | "SPEAKING STYLE (NATURAL, CONCISE, HUMAN)" — short turns, vary acknowledgements, no repeated "No problem", never narrate "I'm checking" without calling the tool, stay silent while tools run, don't repeat customer details. P4 fix. |
| R7 | §4 (new STEP 1.5) | Add | "Handling open-ended, relative, or 'any day' requests" — exact mapping of "Monday / tomorrow / earliest / any day after Saturday / what days do you have" to `date` vs `from`/`to` vs `timezone`-only, and "always actually call the tool when a date is named." P2/P5 fix. |

**Nothing was removed** from the original prompt's business rules. The only deletion is `meeting_type` from the *optional* list (because it is now correctly in the *required* list).

Critical before/after (P1):

> **Before:** "Provide all **four** required arguments: `timezone`, `starts_at`, `confirmed_destination`, `confirmed`. … Optional trip details may also be included when available: **`meeting_type`**, `preferred_trek`, …"
>
> **After:** "Provide all **FIVE** required arguments: `timezone`, `starts_at`, `confirmed_destination`, `confirmed`, **`meeting_type`: Exactly one of `phone`, `whatsapp`, or `video` … Default to `phone` if the customer expressed no preference. Never send any other value.**"

---

## 4. TOOL CHANGES — final schemas

### `get_available_slots` — **NO SCHEMA CHANGE REQUIRED** (keep as-is)
The schema already supports everything needed: `timezone` (required), `date`, `from`, `to`. The fix is flow/prompt-side (argument selection), not schema. Current schema is correct:
```
required: ["timezone"]
properties: timezone(string), date(string YYYY-MM-DD), from(string ISO), to(string ISO)
```
*Optional nicety (not required):* append to the description — "If no date/from/to is given, return the soonest available slots." This helps the model use the no-date call for "earliest available".

### `book_consultation` — **NO SCHEMA CHANGE REQUIRED** (keep as-is)
The schema is already correct — `meeting_type` is a required enum `["phone","whatsapp","video"]`. The bug was never the schema; it was the flow not supplying a valid value. Keep:
```
required: ["timezone","starts_at","confirmed_destination","confirmed","meeting_type"]
meeting_type: { type:string, enum:["phone","whatsapp","video"] }
```
*Optional nicety:* you could add a schema `default` is **not** reliably enforced by Retell, so do **not** rely on it — collect/default in the flow (STEP 6.5) instead.

**Where each required booking value comes from:**
| Field | Source in the conversation |
|---|---|
| `timezone` | Confirmed in "Confirm Customer Local Time"; reused unchanged. |
| `starts_at` | The exact `starts_at` of the slot the customer picked in "Offer Available Slots." (copied verbatim). |
| `confirmed_destination` | From the enquiry / Travel Qualification (`{{enquired_destination}}`, confirmed). |
| `confirmed` | `true` only after the explicit yes in "Confirm Consultation". |
| `meeting_type` | **NEW** — collected in STEP 6.5 / "Confirm Consultation" (phone/WhatsApp/video; default `phone`). |

---

## 5. NODE-BY-NODE REVIEW (all 15)

| Node (id) | Verdict | Why |
|---|---|---|
| Welcome Node (`start-node-1791903579650`) | **KEEP** | Clean static greeting; owns the opening. |
| End Call (`end-call-node-1791903579650`) | **KEEP** | Fine. |
| Travel Qualification (`node-1791905088184`) | **KEEP** (optional trim) | Works; long but correct. Optional: shorten per the new SPEAKING STYLE rules. No functional bug. |
| Polite Closing (`node-1791905406096`) | **KEEP** | Fine. |
| Do Not Contact Closing (`node-1791905720835`) | **KEEP** | Fine. |
| Consultation Requested (`node-1791906234244`) | **KEEP** | Transitions via `skip_response_edge` → Confirm Customer Local Time. Fine. |
| Consultation Declined (`node-1791906267266`) | **KEEP** | Fine. |
| Confirm Customer Local Time (`node-1793648807205`) | **KEEP** | Timezone handling is thorough and worked correctly in the test. Do not touch. |
| **Get Available Slots** (`node-1792684792464`) | **MODIFY** | Add an instruction guiding argument selection (currently empty); keep `else_edge` → Availability Check Issue. (P2) |
| **Offer Available Slots.** (`node-1792687749437`) | **MODIFY** | Broaden the re-check edge so any named/relative date actually re-calls the tool. (P2) |
| **Confirm Consultation** (`node-1792688023469`) | **MODIFY** | Add `meeting_type` collection + pass it. (P1) |
| **Book Consultation** (`node-1792687514318`) | **MODIFY** | Narrow the success edge to `booked === true`; route everything else to Booking Not Confirmed. (P3) |
| **Booking Confirmed** (`node-1792688259042`) | **KEEP** (minor) | Guardrail already prevents false confirms; keep. Only reachable on true after the edge fix. |
| **Booking Not Confirmed** (`node-1792688342553`) | **REBUILD** | Add recovery edges back into scheduling so a failed/again-wanted booking can retry. (P3) |
| Availability Check Issue (`node-1793650582856`) | **KEEP** | Good failure copy + retry edge. |

### Replacement instructions (paste into the node's instruction field)

#### ▸ Get Available Slots (`node-1792684792464`) — ADD instruction
```
This node calls get_available_slots. Build the arguments from the conversation at entry:

- Always include `timezone` = the customer's confirmed IANA timezone from "Confirm Customer Local Time". Never call with an unconfirmed timezone.
- If the customer named a specific or relative day, include `date` = that day resolved to YYYY-MM-DD in the confirmed timezone (never a past date).
- If the customer asked for the earliest/soonest/any availability with no specific day, call with `timezone` ONLY (omit `date`).
- If the customer asked for a range such as "after Saturday" or "next week", include `from` and `to` ISO timestamps bounding that range and omit `date`.

Make exactly one call for the request and wait for the result. Do not speak while it runs. Never claim a day is unavailable unless this tool returned no slots for it. On a valid response (slots or empty) continue to Offer Available Slots; a genuine function error follows the fallback to Availability Check Issue.
```
- **Transitions:** unchanged. Keep edge → Offer Available Slots ("function returns a valid availability response, slots or empty"); keep `else_edge` → Availability Check Issue.
- **Tool:** keep `get_available_slots` attached.

#### ▸ Offer Available Slots. (`node-1792687749437`) — change ONE edge condition
Keep the full existing instruction (it is good). Change only the transition **to Get Available Slots (`node-1792684792464`)**:
- **Current condition:** *"The customer has rejected the offered appointment times or the selected date has no available slots, and the customer has provided a different, clear future consultation date."*
- **Replace with:**
```
The customer names, asks about, or agrees to check any other day, date, relative date (e.g. "tomorrow", "Monday", "next week"), date range, or the earliest/any availability — including after a date returned no slots or after they decline the offered times. Transition here and actually call get_available_slots for that request in the same turn. Do not describe checking a date without transitioning to this node.
```
- Keep the other two edges (→ Confirm Consultation on a clear slot selection; → Polite Closing on decline).

#### ▸ Confirm Consultation (`node-1792688023469`) — REPLACE instruction (adds meeting_type)
```
Before booking, confirm the slot and the meeting method in one short exchange.

1. Repeat the confirmed destination and the exact selected date and time in the customer's confirmed local timezone (human-readable name). Use the same IANA timezone used for availability; if they corrected it earlier, use the corrected one.
2. In the same breath, ask how they'd like to meet: "And would you prefer the consultant to reach you by phone, WhatsApp, or video?"
3. Ask once: "Shall I book that for you?" Wait for an explicit yes.

Set `meeting_type` from their answer: phone/call/voice -> phone; WhatsApp -> whatsapp; video/Zoom/Meet -> video. If they have no preference or just say "book it", use `phone` and say briefly "I'll set it up as a phone call." Never use any value other than phone, whatsapp, or video.

If the customer agrees, proceed to Book Consultation and pass:
- `starts_at`: the exact UTC timestamp of the selected slot from get_available_slots — never generate, convert, or modify it.
- `timezone`: the confirmed IANA timezone (identical to availability).
- `confirmed_destination`: the confirmed destination.
- `confirmed`: true (only because they explicitly agreed).
- `meeting_type`: phone, whatsapp, or video as above.

If the customer wants a different time or date, do not book — return to checking availability for their new preference using the same confirmed timezone. If their location/timezone changed, return to Confirm Customer Local Time first. Never assume consent or book automatically.
```
- **Transition:** unchanged (→ Book Consultation on explicit confirmation).

#### ▸ Book Consultation (`node-1792687514318`) — REPLACE instruction + fix edges
Instruction:
```
Call book_consultation with all five required arguments (timezone, starts_at, confirmed_destination, confirmed, meeting_type). Then branch strictly on the result's `booked` field. `booked` true means an appointment was actually created; anything else (false, missing, or an error/reason) means it was not. Never describe a non-true result as booked.
```
- **Edge 1 (replace the catch-all condition)** → **Booking Confirmed (`node-1792688259042`)**:
```
The book_consultation result has `booked` equal to true (an appointment was actually created).
```
- **`else_edge`** → **Booking Not Confirmed (`node-1792688342553`)** (already points here — keep it; it now carries every non-true result: booked false, missing, handoff-only, or error).
- **Tool:** keep `book_consultation` attached; keep `wait_for_result: true`.

#### ▸ Booking Not Confirmed (`node-1792688342553`) — REPLACE instruction + ADD recovery edges
Instruction:
```
The booking did not create a confirmed appointment. Handle it naturally and never say the appointment is booked.

- If the result indicates the request/details were submitted and a consultant will follow up, say: "I've shared your details with our travel team and a consultant will reach out shortly to finalise a time. Thank you!" Do not apologise and do not call it a confirmed appointment.
- If the slot is no longer available or the booking simply didn't go through, say briefly that that time didn't go through and offer to try another available time or another date. Do not read out internal system messages.
- If the customer wants to try again, go back and offer another time or check another date, then book again only after a fresh explicit confirmation.
- If the customer is done, thank them and close politely.

Keep it to one or two short sentences.
```
- **Edges — ADD:**
  - → **Offer Available Slots. (`node-1792687749437`)**: *"The customer wants to pick a different one of the times that were already offered for this date."*
  - → **Get Available Slots (`node-1792684792464`)**: *"The customer wants to try a different date or a fresh availability check."*
  - **Keep** `skip_response_edge` → End Call for when the booking was a successful handoff or the customer is done.
  - (Optional) → **Polite Closing (`node-1791905406096`)**: *"The customer declines to try again."*

---

## 6. Transition / branch changes (summary)

| Node | Edge | Before | After |
|---|---|---|---|
| Book Consultation | explicit → Booking Confirmed | catch-all prompt (fires always) | **`booked === true` only** |
| Book Consultation | `else_edge` → Booking Not Confirmed | present but dead | now the real path for `booked:false`/missing/error |
| Booking Not Confirmed | (none back to scheduling) | dead-ends at End Call | **add** → Offer Available Slots and → Get Available Slots (retry) |
| Offer Available Slots. | → Get Available Slots | "rejected offered times … new date" | **any named/relative/range/earliest date → re-check** |
| Get Available Slots | instruction | empty | argument-mapping instruction |

No tools need attaching/detaching beyond what's already set. No nodes need deleting.

---

## 7. Booking success / failure logic (exact)

Retell conversation-flow function nodes branch by **prompt-based edge conditions evaluated on the tool's JSON result**, plus an `else_edge` fallback. There is no strict JSON-equality operator, so the safe pattern is: a **narrow success condition** + **everything else via `else_edge`** + a **node-level guardrail** that repeats the rule. Configure:

```
Book Consultation (function)
 ├─ edge  → Booking Confirmed      IF  result.booked == true   ("...`booked` equal to true (an appointment was actually created)")
 └─ else  → Booking Not Confirmed  (every other result: false, missing, error, handoff-only)

Booking Confirmed   : instruction already says "Never claim an appointment was booked unless the function confirms it was created." (guardrail kept)
Booking Not Confirmed: never announces a booking; offers retry; loops back to scheduling or closes.
```
This guarantees the agent can only say "confirmed" on `booked:true`, and a `booked:false` (like the test) lands in Booking Not Confirmed with a real retry path.

---

## 8. Natural conversation improvements

Captured in the global prompt's new **SPEAKING STYLE** section (R6) and the "don't narrate checking" rule (R7). Concretely the agent must:
- Keep turns to 1–2 short sentences; act instead of narrating.
- Vary acknowledgements; **never** repeat "No problem" (it said it repeatedly in the test).
- **Never** say "I'm checking", "sorry for the delay", or "I don't have the result yet" — if it hasn't called the tool, it calls it; while the tool runs (`wait_for_result:true`) it stays quiet.
- Not repeat the customer's details except at final confirmation.
- Not be over-enthusiastic or over-apologetic.

**Agent-level setting (not in the flow):** lower **`interruption_sensitivity` from `0.9` to ~`0.6–0.7`** to stop the choppy, fragmented agent turns ("I", "I'm…") seen in the transcript. Leave `voice_speed:1`. (This is an agent setting, edited on the agent, not a flow node.)

---

## 9. Edge-case handling (all compatible with the real tools)

| Scenario | Behavior | Where |
|---|---|---|
| Date unavailable | Tool returns empty → "no slots on that date, another day?" | Offer §2 (exists) |
| Customer names another date immediately | Re-call `get_available_slots` with new `date` | Offer re-check edge (fix) + Get Available Slots instr |
| Changes mind after selecting a slot | Do not book; return to availability | Confirm Consultation (exists) |
| Wants a different time (same date) | Offer remaining returned slots; if needed re-check that date | Offer §3 / Booking Not Confirmed retry |
| "any available day" / "earliest" | Call with `timezone` only | Global STEP 1.5 (R7) + Get Available Slots instr |
| "next week" / "after Saturday" | Call with `from`/`to` range | Global STEP 1.5 (R7) |
| Ambiguous date | One short clarifying question, then call tool | Global STEP 1.5 |
| Selects then changes slot | Keep latest selection's exact `starts_at`; re-confirm | Confirm Consultation |
| Booking fails (`booked:false`) | Never confirm; explain; offer retry | Book Consultation else → Booking Not Confirmed |
| Booking succeeds (`booked:true`) | Confirm with returned date/time | Booking Confirmed |
| Availability empty | Ask for another date | Offer §2 |
| Availability tool errors | "trouble checking… try again?" (don't claim empty) | `else_edge` → Availability Check Issue (exists) |
| Booking tool errors | Treated as not-booked | else → Booking Not Confirmed |
| Asks what methods exist | "phone, WhatsApp, or video" | Confirm Consultation STEP 6.5 |
| Refuses to choose a method | Default `phone`, state it briefly | STEP 6.5 / global R3 |
| "just book it" | Use `phone`, proceed | STEP 6.5 |
| Interrupts while agent speaks | Lower interruption_sensitivity; honor the interruption | Agent setting |
| Says busy | Polite close (no callback promise) | Global §8 (exists) |
| Asks to call back later | Acknowledge; no callback promise unless a workflow exists | Global §8 / Availability Check Issue |

---

## 10. Exact implementation order (safest sequence)

1. **Agent setting:** lower `interruption_sensitivity` 0.9 → 0.7. *(Smallest, reversible; immediately improves speech.)*
2. **Global prompt:** replace with [`global-prompt-REVISED.txt`](./global-prompt-REVISED.txt). *(Fixes P1 at the policy level + speaking style + date handling.)*
3. **Node — Confirm Consultation:** paste the new instruction (collects `meeting_type`). *(P1 at the flow level.)*
4. **Node — Book Consultation:** paste new instruction; set success edge condition to `booked === true`; confirm `else_edge` → Booking Not Confirmed. *(P3.)*
5. **Node — Booking Not Confirmed:** paste new instruction; add retry edges → Offer Available Slots and → Get Available Slots. *(P3 recovery.)*
6. **Node — Offer Available Slots.:** replace the re-check edge condition. *(P2.)*
7. **Node — Get Available Slots:** add the argument-mapping instruction. *(P2.)*
8. *(Optional)* tweak the two tool **descriptions** (no schema change).
9. **Save the flow.** (Leave the agent `is_published:false` as today unless you intend to publish; there is only v0, so the saved draft is what runs.)
10. **Test** (section 11). Re-run the exact Mon/Tue/Sat scenario first.

No step deletes anything; each is independently revertible.

---

## 11. Test checklist

Run as outbound test calls (your own number), then inspect each with `GET /v2/get-call/{id}` and check the tool sequence:

- [ ] **Happy path:** pick the first offered Saturday slot, choose "phone" → `book_consultation` sends `meeting_type:"phone"` → `booked:true` → agent says confirmed → "Booking Confirmed".
- [ ] **Meeting type = WhatsApp / video:** verify the exact enum value is sent.
- [ ] **No method preference / "just book it":** verify `meeting_type:"phone"` (default) is sent, not free text.
- [ ] **Tuesday scenario (P2):** ask for Monday (empty), then Tuesday → verify a **real** `get_available_slots` call fires with `date:2026-11-24` (no stall, no "I don't have the result yet").
- [ ] **"Earliest available":** verify a `get_available_slots` call with `timezone` only.
- [ ] **"Any day after Saturday" / "next week":** verify a `from`/`to` ranged call.
- [ ] **Booking failure recovery (P3):** force a failure → agent must **not** say confirmed, must offer another time, and a **second** `book_consultation` must fire after re-confirmation.
- [ ] **No false confirms:** confirm the agent never says "confirmed" unless the retrieved result has `booked:true`.
- [ ] **`starts_at` integrity:** the booked `starts_at` exactly equals a returned slot's `starts_at`.
- [ ] **Timezone:** `get_available_slots` and `book_consultation` carry the same confirmed IANA timezone.
- [ ] **Speech quality:** no repeated "No problem", no "I'm checking…" narration without a tool call, fewer fragmented turns (after lowering interruption sensitivity).
- [ ] **Availability error path:** simulate a tool error → "Availability Check Issue" copy, no false "no slots".

---

### Appendix — IDs quick reference
- Agent `agent_e3152e8046a938387ba7a52cc1` · Flow `conversation_flow_68e14abb3d41`
- Tools: `get_available_slots` (`tool-1792684751234`), `book_consultation` (`tool-1792687510547`) — both POST `https://caller.redpandatours.com/webhooks/retell/booking`
- Nodes: Get Available Slots `node-1792684792464` · Offer Available Slots. `node-1792687749437` · Confirm Consultation `node-1792688023469` · Book Consultation `node-1792687514318` · Booking Confirmed `node-1792688259042` · Booking Not Confirmed `node-1792688342553` · Availability Check Issue `node-1793650582856` · Confirm Customer Local Time `node-1793648807205`

> The booking backend (`caller.redpandatours.com/webhooks/retell/booking`) is **your** CallScheduler service — the enforced `meeting_type` values live in its `retellBookingFunction` handler. These changes make the agent send what that service already accepts; no backend change is required for this fix.
