# Missed-call textback

Someone rings a contractor who's up a ladder. He can't answer. Within seconds
they get a WhatsApp asking what they need — so they reply instead of dialling
the next electrician in the search results.

Built as the cheaper, faster-to-ship sibling of `../voice-agent`, and for
India arguably the better product: everyone is already on WhatsApp, and it
sidesteps the +91 phone-number wall that blocks inbound voice.

## Why this exists

The voice agent needs an Indian inbound DID, which needs TRAI/DoT regulatory
approval — days to weeks. This needs none. It can be demoed the same day.

## What's here

| File | What it is |
|---|---|
| `templates.json` | The messages. This is the product; the plumbing is commodity. |
| `server.mjs` | Fires the template on a missed call, forwards replies to the owner. |

## How it works

```
missed call ──► POST /missed-call ──► WhatsApp template to the caller
                                            │
                       caller replies ◄──────┘
                                            │
                                            ▼
                              POST /webhook (Meta)
                                            │
                          ┌─────────────────┴─────────────────┐
                          ▼                                   ▼
             acknowledge the caller            forward the lead to the
             (urgent variant if it             owner's own WhatsApp
             mentions burning/sparking)
```

## The trigger — the one part left open

Something has to tell this that a call was missed. Options, honestly ranked:

1. **An automation app on the owner's phone** (MacroDroid, Tasker, Automate).
   Detects a missed call, POSTs the number here. No DID, no forwarding, no
   carrier involvement, works on his existing number. Fiddly to set up once,
   free forever. **Best fit for a single contractor.**
2. **Conditional call forwarding to a VoIP number** whose provider webhooks
   on ring. Cleaner, but reintroduces the DID problem and Indian carriers
   often block or charge for forwarding to international numbers.
3. **Anything else that can make an HTTP request** — Zapier, a CRM, curl.

Nothing here assumes a particular choice; `/missed-call` takes a number and
sends. Swap the trigger without touching the service.

## Constraints worth knowing before you promise anything

**The API number can't be his existing WhatsApp.** A number registered to
WhatsApp Business API cannot also be on the normal WhatsApp app. He'll need a
second number for the business line, or to migrate his current one and lose
the app on it. This surprises people — raise it early, not at handover.

**Templates need Meta approval.** A missed call doesn't open a messaging
window — they rang a phone, they didn't message you — so the first message
must be a pre-approved template. Submit under **UTILITY**; anything that
reads like marketing gets rejected or throttled. Approval is usually hours,
sometimes longer. Do this before demo day, not on it.

**Cost.** Meta gives 1,000 free service conversations a month, which is far
more than one contractor will use. Beyond that it's fractions of a rupee per
conversation. Effectively free at this scale — charge for setup, not usage.

## Running it

```bash
cp .env.example .env     # fill in the Meta credentials
node server.mjs
```

Expose it for Meta's webhook (`ngrok http 3000` or deploy it), then point the
webhook at `https://.../webhook` using the same `WA_VERIFY_TOKEN`.

Test without a real missed call:

```bash
curl -X POST localhost:3000/missed-call \
  -H 'Content-Type: application/json' \
  -d '{"from":"+919110819125"}'
```

## Design notes

- **No selling in the first message.** It's a utility template by category and
  by intent — one question, no links, no pitch. Selling there gets it
  rejected by Meta and ignored by the customer.
- **Emergency detection is shared** with the voice agent — same signals
  (burning, sparking, water, no power), same rule: safety guidance only,
  never a fix instruction, never a diagnosis.
- **The lead lands in the owner's WhatsApp**, not a dashboard. He is on a
  roof. He will not open a dashboard.
- **The webhook acks before doing work.** Meta retries aggressively on slow
  responses and would otherwise double-send.
