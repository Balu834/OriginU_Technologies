# Voice reception agent — Planet Electrical

Answers calls a contractor can't pick up while on site: takes the problem,
the area, the urgency and a callback number, then texts/emails him a two-line
summary. Built first for Mohamed Ubedulla, Planet Electrical, Bangalore.

## What's here

| File | What it is |
|---|---|
| `assistant.json` | The product. Prompt, voice, transcriber, and the structured fields pulled off every call. |
| `setup.mjs` | Creates/updates the assistant on Vapi; optionally places a demo call. |

`assistant.json` is the actual IP — the telephony is a commodity, the prompt
is what makes it usable by a working electrician rather than a generic bot.

## What it costs (be honest with yourself before promising a client)

| | |
|---|---|
| Vapi | free credit on signup, then usage-based |
| Per minute, all in | roughly $0.10–0.15 (LLM + voice + telephony) |
| A 90-second call | ~2p / ₹2 |
| US number for outbound | ~$2/month |

A demo call to Mohamed costs cents. Running this in production for one
contractor taking ~20 calls a day is single-digit dollars a month in usage.
Price the setup work, not the minutes.

## The India problem — read this before selling inbound

The demo works today. **Production inbound does not, yet.**

Vapi hands you a US (+1) number instantly, and dialling *out* to +91 from it
is fine. But for this to actually answer Mohamed's business calls, his callers
must reach a number he owns — and getting an Indian (+91) DID means TRAI/DoT
regulatory approval, a business address proof and a KYC bundle. Twilio and
every other provider enforce it. Days to weeks, not minutes.

Two ways around it, both worth confirming with him rather than assuming:

1. **Conditional call forwarding.** He keeps his number, and sets
   forward-on-no-answer / forward-on-busy to the agent's number. His callers
   never see a different number. Works on Indian mobile networks (`*61*` and
   `*67*` codes, carrier dependent), but forwarding to an international
   number may be blocked or chargeable on his plan — check with his operator.
2. **Missed-call textback instead of voice.** Cheaper, no DID needed, and
   arguably fits India better since everyone lives on WhatsApp. He misses a
   call, the caller instantly gets a WhatsApp/SMS asking what they need.
   Less impressive as a demo, faster to ship, no regulatory wall.

## Running it

```bash
cp .env.example .env      # fill in VAPI_API_KEY
node setup.mjs            # create/update the assistant
```

Then open the Vapi dashboard and use **Talk to Assistant** — browser mic, no
phone, no cost. Iterate on the prompt there until it sounds right.

When it's ready to demo down a real phone line:

```bash
node setup.mjs --call +919110819125
```

Re-running is safe: it updates the existing assistant by name rather than
creating duplicates.

## Demoing it to Mohamed

Don't ask him to ring a US number — international rates, and he won't.
Instead the agent calls **him**, and he plays the customer. Tell him up front:
"pretend you've got a fuse tripping at home and you're calling an electrician."

He hears exactly what his own customer would hear. That is the entire pitch.

## Prompt design notes

Decisions in `assistant.json` that are deliberate, not accidental:

- **No prices, ever.** It cannot quote, estimate or hint. A wrong number from
  a receptionist costs the contractor the job or the margin.
- **No diagnosis.** It never guesses the fault. Liability, and it would be
  wrong often enough to embarrass him.
- **Emergency short-circuit.** Burning smell, sparking, water near electrics,
  or total outage with vulnerable people — it stops asking questions, gets the
  number, and ends. Speed matters more than a complete record.
- **Admits what it is.** Asked directly whether it's a person, it says no.
  Denying it and being caught is worse for his reputation than being an
  honest automated line.
- **Multilingual transcriber.** Bangalore callers switch to Hindi or Kannada
  mid-sentence; the agent follows without remarking on it.
- **Two-line summary.** Written to be read on a phone, standing on a ladder.
