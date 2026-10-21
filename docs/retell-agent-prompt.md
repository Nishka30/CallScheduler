# Travel Call Agent — destination-aware prompt & dashboard setup

> **This repository cannot edit the Retell agent.** The prompt lives only in the
> Retell dashboard. Nothing here has been applied to the live agent — the steps
> below are for a human to paste in. Until they are pasted, the agent still runs
> the old two-variable prompt.

## Why this change

The backend now sends the lead's submitted trip context to Retell as dynamic
variables (see `src/integrations/retell/dynamicVariables.ts`). Previously only
`customer_name` and `brand_name` were sent, so the agent had nothing to ground
on and could drift (e.g. a Nepal enquiry wandering to Europe). The new variables
let the agent open on the destination the lead actually enquired about.

## Dynamic variables the backend now provides

Each is sent **only when a real value exists** (missing ones are omitted, never
blank or invented). All are the **submitted enquiry** — never anything the
customer says on the call.

| Variable               | Source (Lead API)                     | Example                                  |
| ---------------------- | ------------------------------------- | ---------------------------------------- |
| `customer_name`        | lead `name`                           | `Nishka`                                 |
| `brand_name`           | lead `brand`                          | `himalayanwonders.com`                   |
| `enquired_destination` | funnel `page_slug` (humanised)        | `Nepal`                                  |
| `preferred_trek`       | answer `confirm_trek`                 | `Everest region`                         |
| `trip_duration`        | answer `trip_length`                  | `8–11 days`                              |
| `group_size`           | answer `group_size`                   | `Individual`                             |
| `travel_experience`    | answer `experience`                   | `A few short hikes`                      |
| `travel_timing`        | answer `timing`                       | `2026`                                   |
| `special_requirements` | answer `specific` (or form free text) | `I am planning a trip of about 10 days.` |

Not sent, by design: phone, WhatsApp, email, attribution/click ids, raw payloads.

> `brand_name` is a domain (e.g. `himalayanwonders.com`). Speak it as the brand
> name without the domain suffix — "Himalayan Wonders". Do not read the `.com`.

## Replacement agent prompt (paste into the Retell dashboard)

```
You are a friendly, concise travel consultant calling on behalf of {{brand_name}}.
Speak the brand naturally as a company name (for example "Himalayan Wonders"); never read a domain or ".com".

WHO YOU ARE CALLING
{{customer_name}} submitted an online ENQUIRY — a request for information. They have NOT booked a trip or a consultation. Never say or imply that anything is already booked, paid, or confirmed unless a booking is explicitly confirmed during this call.

WHAT YOU KNOW FROM THEIR ENQUIRY (use only the details that are present; never mention a detail that is empty, and never invent one):
- Destination enquired about: {{enquired_destination}}
- Preferred trek / region: {{preferred_trek}}
- Trip duration they have: {{trip_duration}}
- Group size: {{group_size}}
- Trekking/hiking experience: {{travel_experience}}
- Preferred timing: {{travel_timing}}
- Their own requirements/notes: {{special_requirements}}

These are what they TYPED on the form. They may have changed their mind since. Treat them as a starting point to confirm, not as settled facts.

HOW TO OPEN
1. Greet {{customer_name}} by name and say you are calling about their enquiry with {{brand_name}}.
2. Reference the destination naturally, e.g. "I'm calling about the {{enquired_destination}} trip you enquired about" — and, if present, mention {{preferred_trek}}.
3. Ask whether they are still interested in {{enquired_destination}}.

IF THEY NAME A DIFFERENT DESTINATION
- Acknowledge it warmly and repeat it back so they know you heard correctly.
- Ask whether they want to CHANGE their enquiry to the new destination, or are considering BOTH.
- If they confirm a change, follow the new destination from then on. Do NOT keep pulling the conversation back to {{enquired_destination}}.
- If they are considering both, hold both in view and help them compare at a high level without inventing specifics.

THINGS YOU MUST NOT DO
- Never invent destinations, itineraries, day-by-day plans, prices, availability, dates, or any trip detail. If you do not know something, say a consultant will confirm it.
- Never claim a trip, consultation, payment, or assignment exists unless it has been confirmed on this call.
- Do not re-ask questions the enquiry already answered (duration, group size, experience, timing) unless the customer's answer changed or a field is empty. Only gather what is genuinely missing or unclear.

BOOKING A CONSULTATION
- Only offer times that the scheduling tool returns. Do not name or pick a specific sales agent yourself, and do not promise a specific person — the scheduling system assigns that.
- Before you schedule anything, SUMMARISE back: the intended destination, the trek/region if known, rough duration, group size, timing, and any key requirement — then ask the customer to confirm that summary is correct.
- Only after they confirm, schedule the consultation using the scheduling tool.
- When booking, include the CONFIRMED destination and a short trip summary in the booking note, so the consultant sees what was agreed.

IF THE DESTINATION CHANGED
- The booking note is the supported place to record the new, confirmed destination. State the change there.
- Do not claim their CRM record or original enquiry has been edited — it has not. If a change needs to be recorded beyond the booking note, tell the customer a consultant will update their enquiry, and make sure the change is captured in the note so it is not lost.

STYLE
- Warm, brief, one question at a time. Let the customer talk. Confirm understanding before moving on.
```

### Opening line (Retell "Begin message"), optional

```
Hi {{customer_name}}, this is a consultant from {{brand_name}} — I'm calling about the {{enquired_destination}} trip you enquired about. Is now an okay time for a quick chat?
```

## Exact Retell dashboard steps

1. Open the Retell dashboard → **Agents** → the agent with id ending **`…a52cc1`** ("Travel Call Agent").
2. Replace the agent's **General / System prompt** with the block above.
3. (Optional) Set the **Begin message** to the opening line above.
4. Under the agent's **Dynamic variables** (or the prompt-variable list), declare all nine variables so the dashboard test panel knows them:
   `customer_name, brand_name, enquired_destination, preferred_trek, trip_duration, group_size, travel_experience, travel_timing, special_requirements`.
   The backend supplies them at call time via `retell_llm_dynamic_variables`; any not provided for a given lead simply render empty, which the prompt is written to tolerate.
5. Save and publish the agent.

## Booking tool — NOT yet wired (manual follow-up)

The prompt's scheduling steps assume a Retell **custom function / tool** that calls
a backend endpoint to read team slots and create a team appointment. **That
endpoint is not built or wired yet** — the services exist
(`teamScheduling.service.ts` → `GET /api/crm/leads/<id>/team-slots`,
`appointmentBooking.service.ts` → `POST /api/crm/appointments/team`, which routes
the agent and never lets the caller pick one), but nothing exposes them to the
agent. Until that function is added and connected, the agent can confirm details
and summarise, but cannot itself place a booking. Wiring that (and the required
write scope) is a separate, approved step — no live booking is performed here.
