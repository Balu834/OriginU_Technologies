# MissedCall QR gateway (UNOFFICIAL)

An always-on service that holds WhatsApp "linked device" sessions for
MissedCall businesses that chose **Connect by scanning a QR code** instead of
the official Facebook / Embedded Signup route. Built on
[Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys`,
pinned to `7.0.0-rc14`).

## Read this before switching it on

- **This breaks WhatsApp's terms of service.** It is not a grey area.
- **Numbers can be banned without warning**, for a while or for good. Many
  numbers linked from one data-centre address makes that more likely. We do
  not try to hide that, and must not.
- **A ban hits the customer's real business number**, the one on their
  signboard, Google listing and visiting cards.
- **Never market it as "official" or "Meta-approved"** anywhere: landing
  page, settings page, emails, sales calls.
- **Risk to OriginU's Meta Tech Provider status.** Running an unofficial
  client beside an approved Tech Provider app could put that approval at
  risk if Meta notices.
- **The gateway sees the owner's whole WhatsApp.** Every personal-chat text
  to the number is forwarded to the app, which answers only recent callers
  and drops everything else without storing it. Treat
  `INTEGRATION_ENCRYPTION_KEY` and the Upstash token as critical.

## How it fits

```
owner presses Start ─► app POST /sessions/start ─► gateway opens Baileys socket
                                                     │ QR / pairing code
page polls app /settings/whatsapp/qr/status ◄─ app POST /sessions/status
owner scans ─► gateway ─► app POST /qr/events {connection: connected, phone}
                           app records provider=whatsapp_qr, CONNECTED

missed call ─► app reportMissedCall ─► QR client ─► gateway /sessions/send
customer reply ─► gateway ─► app /qr/events {message} ─► conversation
                                       └─ owner alert from MissedCall's official number
```

Every request both ways is signed with `QR_GATEWAY_SECRET`
(`../lib/qrSigning.mjs`, HMAC-SHA256 over timestamp + body, 5-minute window).
Requests to the gateway also carry a one-time `requestId`.

Sessions are stored in the same Upstash Redis as the app, under `waqr:*`,
every value AES-256-GCM encrypted with the app's `INTEGRATION_ENCRYPTION_KEY`
(`../lib/crypto.mjs`). A per-business lock (`waqr:lock:<id>`) means only one
machine ever holds a session. Logout, a WhatsApp unlink or a ban deletes all
of that business's keys.

No chat history is synced. Groups, status, broadcasts and channels are
dropped in the gateway. Sends show "typing…" for a moment first and are
capped per number per hour (`QR_MAX_SENDS_PER_HOUR`, default 60).

## Environment

| Variable | What |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | The app's Upstash Redis (same values as Vercel) |
| `INTEGRATION_ENCRYPTION_KEY` | Same 64-hex key as the app |
| `QR_GATEWAY_SECRET` | ≥32 chars, same value as the app's `QR_GATEWAY_SECRET` |
| `MISSEDCALL_APP_URL` | The app's public URL, e.g. `https://missedcall.originutech.in` |
| `QR_MAX_SENDS_PER_HOUR` | Optional, default 60 |
| `BAILEYS_LOG_LEVEL` | Optional, default `warn` (lower levels log message contents) |

On the app (Vercel): `QR_GATEWAY_URL=https://<app>.fly.dev`, the same
`QR_GATEWAY_SECRET`, and `QR_CONNECT_ENABLED=1` only when you want the option
shown. Also make sure the `new_lead_alert` template is approved in MissedCall's
own WABA, since QR businesses' owner alerts go from that number.

## Deploy (Fly.io, Mumbai) — only after approval

From the `missed-call-textback` folder (the image also copies two files from
`lib/`):

```bash
fly apps create missedcall-qr-gateway
fly secrets set --config qr-gateway/fly.toml KV_REST_API_URL=... KV_REST_API_TOKEN=... INTEGRATION_ENCRYPTION_KEY=... QR_GATEWAY_SECRET=... MISSEDCALL_APP_URL=...
fly deploy . --config qr-gateway/fly.toml --dockerfile qr-gateway/Dockerfile
```

One `shared-cpu-1x` 1 GB machine is enough for about 10 businesses (one
process with one session measured ~107 MB; plan ~40–60 MB per extra session).
Add a second machine past ~70% memory; a request for a session held by the
other machine is handed over with Fly's `fly-replay` header.

## Run and test locally

```bash
npm ci
npm test
node scripts/smoke-qr.mjs
```

`npm test` uses a fake socket and in-memory Redis. `scripts/smoke-qr.mjs`
opens one real session against WhatsApp and waits for a QR. It links
nothing, sends nothing and stores nothing.

## Operating it

- Watch `/health` (session and connected counts, memory) and the app's logs
  for `qr_connection_lost`.
- When WhatsApp changes its protocol, every QR business stops until Baileys
  is updated. Update by bumping the pinned version, running the tests and
  the smoke script, then deploying.
- An owner's phone offline for ~14 days unlinks the device; they re-scan.
