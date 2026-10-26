# Missed-call textback

Someone rings a contractor who's up a ladder. He can't answer. Within seconds
they get a WhatsApp asking what they need — so they reply instead of dialling
the next electrician in the search results. The reply is turned into a
structured lead through a short, natural conversation, and Mohamed gets a
two-line notification on his own WhatsApp.

Built as the cheaper, faster-to-ship sibling of `../voice-agent`, and for
India arguably the better product: everyone is already on WhatsApp, and it
sidesteps the +91 phone-number wall that blocks inbound voice.

## What it does

```
missed call ──► WhatsApp template ──► conversation ──► lead ──► notify Mohamed
```

1. Mohamed misses a call.
2. Phone automation on his Android POSTs the caller's number to `/missed-call`.
3. The service sends an approved WhatsApp utility template — the *only* thing
   allowed as a first message, since a missed call doesn't open a messaging
   window.
4. The customer replies. A short, natural back-and-forth fills in name, area,
   problem, and urgency — never more than one question at a time, never a
   question for something already given.
5. Once the lead is complete (or an emergency signal fires), Mohamed gets a
   concise WhatsApp notification.

```
                 ┌────────────────────┐
                 │ Mohamed's Android  │
                 └─────────┬──────────┘
                      Missed Call
                           ▼
                 ┌────────────────────┐
                 │ MacroDroid/Tasker  │
                 └─────────┬──────────┘
                       HTTPS + API key
                           ▼
                 ┌────────────────────┐
                 │ POST /missed-call  │
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │ WhatsApp Cloud API │──► Customer WhatsApp
                 └────────────────────┘         │
                                               Reply
                                                 ▼
                 ┌────────────────────┐
                 │ POST /webhook      │  (signature-verified)
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │ Conversation state │
                 │ + field extraction │
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │ Lead storage       │  data/db.json
                 └─────────┬──────────┘
                           ▼
                 ┌────────────────────┐
                 │ Mohamed's WhatsApp │
                 └────────────────────┘
```

## What's here

| Path | What it is |
|---|---|
| `server.mjs` | HTTP entrypoint — routing, request parsing, startup config check. |
| `config.mjs` | Loads `.env`, applies defaults, reports missing required keys. |
| `routes/` | One file per endpoint (`health`, `missedCall`, `webhook`), each a plain testable function. |
| `lib/whatsapp.mjs` | WhatsApp Cloud API client + `X-Hub-Signature-256` verification. |
| `lib/embeddedSignup.mjs` | Meta Embedded Signup: code exchange, number registration, WABA webhook subscription. The customer-facing way to connect WhatsApp. |
| `routes/whatsappConnect.mjs` | `POST /settings/whatsapp/connect` (finish a signup) and `/settings/whatsapp/test` (re-prove a stored connection). |
| `lib/conversation.mjs` | The state machine: one inbound message in, question/confirmation/notification out. |
| `lib/extract.mjs` | Rule-based extraction of name/area/problem/urgency from free text. |
| `lib/emergency.mjs` | Emergency keyword detection, shared in spirit with `../voice-agent`. |
| `lib/leads.mjs` | Lead data model, summary generation, owner-notification formatting. |
| `lib/store.mjs` | JSON-file persistence behind a small async interface — swap the implementation, not the callers, to move to Postgres/Supabase/Firebase later. |
| `templates.json` | The actual WhatsApp copy — templates to submit to Meta, plus in-conversation prompts. |
| `test/` | `node --test` suite covering webhook auth, missed-call auth, extraction, emergency handling, idempotency. |
| `scripts/demo.mjs` | Simulated end-to-end walkthrough, no Meta credentials needed. |

Zero npm dependencies — same philosophy as the original: `node:http`,
`node:crypto`, `node:test`, and `fetch`, nothing else.

## Environment variables

See `.env.example` for the full annotated list. Required for the server to
start:

```
META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_VERIFY_TOKEN, META_APP_SECRET,
MOHAMED_WHATSAPP_NUMBER, MISSED_CALL_API_KEY, BUSINESS_NAME, OWNER_NAME
```

Missing any of these and `node server.mjs` exits immediately with a clear
error — it will not start in a half-configured state and silently fail
later. `META_WABA_ID` and `WEBHOOK_BASE_URL` are informational/reference
only; nothing in the running server calls the WABA-level API.

## Running it

```bash
cp .env.example .env     # fill in the Meta credentials
npm start                # same as: node server.mjs
```

```bash
npm test                 # node --test test/
npm run demo             # simulated walkthrough, no credentials needed
```

## How a customer connects their WhatsApp

A business owner never handles a Meta credential. On `/settings/whatsapp`
they see one button:

```
Connect WhatsApp  ──►  Meta's Embedded Signup popup
                         │  customer signs in with Meta
                         │  picks/creates their WhatsApp Business Account
                         │  picks their business phone number
                         ▼
   Meta returns  waba_id + phone_number_id  (postMessage)
                 exchangeable code          (FB.login callback)
                         ▼
   POST /settings/whatsapp/connect   (same-site session, JSON body)
                         ▼
   server: exchange code -> customer-scoped business token
           register the number, subscribe our app to their WABA
           store encrypted against THIS business
           verify with Meta, and only then mark CONNECTED
```

The six technical fields (phone number ID, display number, WABA ID, access
token, app secret, verify token) still exist, unchanged, behind **Advanced
/ Manual Setup** on the same page — for a technical administrator, not for
a customer.

Requires `META_APP_ID` and `META_EMBEDDED_SIGNUP_CONFIG_ID`. Without them
the page says one-click connection isn't available and offers Advanced
setup; it never renders a button that cannot complete.

Two things worth knowing:

- **The app secret and verify token are platform-level, not per-business.**
  Meta signs every webhook with the *app* secret, so a per-business one
  would have nothing to verify. Embedded Signup therefore stores neither,
  and `lib/integrations.mjs` keeps them empty for those connections.
- **Only Meta can make a connection CONNECTED.** A completed popup is not
  evidence. `lib/metaVerify.mjs` asks Meta whether the token reaches that
  number and whether that WABA owns it, and its answer is what gets
  recorded — the same rule the manual form has always followed.

### Third option: scan a QR code (UNOFFICIAL)

For an owner with no Facebook at all, the page can also offer **"Connect by
scanning a QR code (unofficial)"**. MissedCall then links to the owner's own
WhatsApp as a linked device, like WhatsApp Web, through a separate always-on
service in [`qr-gateway/`](qr-gateway/README.md) running on Fly.io (Mumbai).

- **It breaks WhatsApp's terms, and the number can be banned without
  warning.** The ban lands on the customer's real business number. The page
  shows these risks first and the owner must tick a box to accept them; who
  ticked and when is stored on the connection.
- **Never call it official or Meta-approved.** Only the Facebook route is.
- Hidden unless `QR_CONNECT_ENABLED=1` and `QR_GATEWAY_URL` /
  `QR_GATEWAY_SECRET` are set. With the flag off, businesses already linked
  keep working; nobody new can start.
- No templates on this route: the missed-call message is the template's
  wording (from `templates.json`) sent as plain text. No 24-hour rule.
- The bot replies **only** to someone who missed-called in the last 48 hours
  or is part-way through the questions. Everyone else who messages the
  owner's number is ignored and not stored. If the owner types to a
  customer from the phone, the bot stays out of that chat until they call
  again.
- **Owner alerts come from MissedCall's own official number** (the
  deployment's `META_*` number, `new_lead_alert` template), because a
  message from the owner's number to itself makes no notification. That
  template must be approved in MissedCall's own WABA.
- Code: `lib/qrGateway.mjs` (client, reply rule), `routes/qrEvents.mjs`
  (`POST /qr/events`, signed, from the gateway), `routes/qrConnect.mjs`
  (start / status / logout), `lib/qrSigning.mjs` (HMAC both ways).

## Meta setup (do this before demo day)

1. Create a Meta Business account and a WhatsApp Business app at
   developers.facebook.com.
2. Add a WhatsApp phone number to the app. **This number cannot also be used
   in the regular WhatsApp app** — it becomes a dedicated API number. Budget
   for a second SIM/number if Mohamed wants to keep using his own WhatsApp.
3. Copy the Phone Number ID and a permanent access token into `.env`
   (`META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`).
4. Copy the App Secret from App Settings → Basic into `META_APP_SECRET` —
   this is what verifies inbound webhook requests are genuinely from Meta.
5. Pick any string for `META_VERIFY_TOKEN`.
6. In the app's WhatsApp → Configuration screen, set the webhook URL to
   `${WEBHOOK_BASE_URL}/webhook` and the verify token to the same value as
   `META_VERIFY_TOKEN`, then subscribe to the `messages` field.
7. Submit `missed_call_immediate` (and optionally `missed_call_after_hours`)
   from `templates.json` for approval under category **UTILITY**. Marketing
   wording gets rejected or throttled — there's deliberately no selling in
   these. Approval is usually hours; do this well before a live demo.
8. Set `WHATSAPP_MISSED_CALL_TEMPLATE` to whichever approved template name
   you want live.

## Local development

Expose the webhook with a tunnel:

```bash
ngrok http 3000
```

Point Meta's webhook config at `https://<ngrok-id>.ngrok.io/webhook`.

Trigger a missed call manually:

```bash
curl -X POST localhost:3000/missed-call \
  -H "Authorization: Bearer $MISSED_CALL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"callerNumber":"+919876543210","timestamp":"2026-08-26T10:30:00+05:30"}'
```

Or run `npm run demo` for a fully simulated flow that needs no tunnel, no
Meta account, and sends nothing over the network.

## Phone automation (MacroDroid / Tasker)

The trigger is deliberately left as "anything that can POST an HTTP
request" — no call forwarding, no Indian DID required.

1. Trigger: **Missed Call** (or **Call Ended, not answered**).
2. Extract the caller's number.
3. Skip if the number is Mohamed's own (the backend also ignores it as a
   safety net, but filtering at the source saves a request).
4. HTTP POST to `${WEBHOOK_BASE_URL}/missed-call`:

```http
POST /missed-call HTTP/1.1
Authorization: Bearer YOUR_MISSED_CALL_API_KEY
Content-Type: application/json

{
  "callerNumber": "+919876543210",
  "timestamp": "2026-08-26T10:30:00+05:30"
}
```

5. The service sends the WhatsApp template, the customer replies, and the
   lead is captured automatically from there — the automation's job ends
   at step 4.

## Leads dashboard

`/` serves a password-protected dashboard of captured leads — name, number
(tap to call), problem, area, urgency, time — newest first, with emergency
leads outlined in red. It's server-rendered with no client-side JS, sized
for a phone, since that's where Mohamed will read it.

Set a password before it will serve anything:

```bash
node scripts/hash-password.mjs "the password you want"
# paste the salt:hash output into DASHBOARD_PASSWORD_HASH
```

With `DASHBOARD_PASSWORD_HASH` unset the dashboard returns 503 rather than
running open — it holds customer PII, so failing closed is the only safe
default.

Security notes, because this is a public URL holding customer data:

- The password is stored only as a salted scrypt hash, compared in constant
  time. The plaintext is never written anywhere.
- Sessions are random 32-byte ids in `HttpOnly; Secure; SameSite=Strict`
  cookies, held server-side in Redis with a 7-day TTL. Signing out deletes
  the session server-side, so the cookie alone is worthless afterwards.
- Failed logins are rate limited per IP (10 per 15 minutes).
- **Every lead field is escaped before rendering.** Names, problems and
  areas are customer-controlled text arriving over WhatsApp, so a customer
  whose "name" is `<script>…` is a stored-XSS attempt against Mohamed's
  browser. `lib/views.mjs` escapes all of it; `test/dashboard.test.mjs`
  covers that specifically.

## Duplicate protection

- **Same missed call sent twice / automation retries**: `/missed-call`
  tracks the last time a template was sent to each caller and skips
  resending within a 10-minute window (`routes/missedCall.mjs`).
- **Meta retries the webhook**: every inbound message carries a WhatsApp
  message ID (`msg.id`); it's recorded the first time it's processed and
  skipped on any later delivery (`lib/store.mjs`).
- **The webhook acks before doing any work** — Meta retries aggressively on
  slow responses, which would otherwise cause double-sends.

## Field extraction — how it works and its limits

`lib/extract.mjs` is a fixed set of regexes, not an LLM call — no extra
credential was requested for this MVP, and a small deterministic rule set is
easier to test and keep from inventing information. It handles:

- A single fact per message ("AC not cooling", "Whitefield", "Ravi").
- Several facts in one message ("I'm Ravi from Whitefield and my AC isn't
  cooling. Need someone today.").
- Direct answers to a direct question — if the bot just asked for the area
  and the reply doesn't match anything more specific, the reply becomes the
  area.

Known limitation: area matching expects a single word (fine for
Whitefield, Indiranagar, Marathahalli, Koramangala, etc.); a genuinely
multi-word area will simply be asked again rather than mis-parsed.

## Emergency handling

Reuses the same signal list as `../voice-agent/assistant.json`: burning
smell, smoke, sparking, exposed live wire, water near electrics, total
power outage. On a hit, the system:

- Never diagnoses the fault or suggests a fix.
- Sends basic safety guidance only (switch off at the mains if safe to
  reach, don't touch anything else).
- Marks the lead urgent and notifies Mohamed immediately, even if the lead
  is otherwise incomplete — safety over lead qualification.

## Storage

A single JSON file (`data/db.json`, gitignored) holds leads, conversation
state, and the idempotency records. `lib/store.mjs` is the only file that
touches it — nothing else in the codebase reads or writes the filesystem for
business data, so migrating to Postgres/Supabase/Firebase later means
reimplementing that one module.

## Language handling

Bangalore customers mix English, Hindi, and Kannada. This MVP's extraction
is regex-based and English-only for now — a mixed-language reply that
doesn't match the English patterns will simply prompt a follow-up question
rather than mis-extract. Full multilingual understanding is a natural
upgrade path (and one place where a real LLM call would earn its keep) but
was out of scope for this pass; document it as a known gap, don't pretend
it's handled.

## Constraints worth knowing before you promise anything

**The API number can't be his existing WhatsApp.** A number registered to
WhatsApp Business API cannot also be on the normal WhatsApp app.

**Templates need Meta approval**, submitted under UTILITY, before the first
message can go out.

**24-hour messaging windows apply.** Once a customer replies, free-form
text is allowed for 24 hours. The owner-notification message sent to
Mohamed is free-form text — if Mohamed hasn't messaged the business number
within the last 24 hours, Meta may reject it. Simplest fix for a solo
operator: have Mohamed send the business number one message
("hi") to open a standing window, or configure an approved template for
notifications if that's not acceptable.

**Business verification/KYC may apply** and approval timelines are not
guaranteed by this project. This system does not eliminate WhatsApp/Meta's
own requirements, only the need for an Indian inbound voice DID.

**Cost.** Meta gives 1,000 free service conversations a month — far more
than one contractor will use. Charge for setup, not usage.

## Design notes

- **No selling in the first message.** Utility template, one question, no
  links, no pitch.
- **One question at a time**, and never one that's already been answered.
- **The lead lands in the owner's WhatsApp**, not a dashboard. He's on a
  roof; he will not open a dashboard.
- **The webhook acks before doing work**, and every message is processed in
  its own try/catch so one malformed event can't take the service down.
- **No secrets in logs.** `lib/logger.mjs` redacts any key that looks like a
  token/secret/signature as a safety net, on top of never passing them in.

## Voice agent

`../voice-agent` is untouched and remains the Phase 2 premium product —
richer, but blocked on an Indian inbound DID. This WhatsApp flow is the
thing that can be demoed and sold today.
