/**
 * Missed-call textback for a one-person trade business.
 *
 *   POST /missed-call   { "from": "+9198...", "afterHours": false }
 *       -> WhatsApps the caller an approved template within seconds
 *
 *   GET/POST /webhook   Meta's verification handshake + inbound messages
 *       -> when the caller replies, forwards it to the owner's WhatsApp
 *
 * The trigger for /missed-call is deliberately left open — see README. Any
 * source that can make an HTTP request works: an Android automation on the
 * owner's phone, a call-forwarding provider's webhook, Zapier, or curl.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const env = {
  ...Object.fromEntries(
    (fs.existsSync(path.join(here, ".env"))
      ? fs.readFileSync(path.join(here, ".env"), "utf8").split(/\r?\n/)
      : []
    )
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  ),
  ...process.env,
};

const required = ["WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", "WA_VERIFY_TOKEN", "OWNER_WHATSAPP", "BUSINESS_NAME", "OWNER_NAME"];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const templates = JSON.parse(fs.readFileSync(path.join(here, "templates.json"), "utf8"));

// Same signals the voice agent treats as an emergency. Kept in one place so
// the two products can't drift apart on what counts as urgent.
const EMERGENCY = /burn|smoke|smoking|spark|shock|fire|live wire|naked wire|water|leak|flood|no power|power gone|short circuit|shortcircuit/i;

const wa = async (payload) => {
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) console.error("whatsapp send failed:", res.status, JSON.stringify(body));
  return { ok: res.ok, body };
};

const sendTemplate = (to, name) =>
  wa({
    to,
    type: "template",
    template: {
      name,
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: env.BUSINESS_NAME },
            { type: "text", text: env.OWNER_NAME },
          ],
        },
      ],
    },
  });

const sendText = (to, body) => wa({ to, type: "text", text: { body, preview_url: false } });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Meta's one-time webhook verification handshake.
  if (req.method === "GET" && url.pathname === "/webhook") {
    const challenge = url.searchParams.get("hub.challenge");
    if (url.searchParams.get("hub.verify_token") === env.WA_VERIFY_TOKEN) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(challenge ?? "");
    }
    return json(res, 403, { error: "bad verify token" });
  }

  if (req.method === "POST" && url.pathname === "/missed-call") {
    const { from, afterHours } = await readBody(req);
    if (!from?.startsWith("+")) return json(res, 400, { error: "from must be an E.164 number" });

    const template = afterHours ? "missed_call_after_hours" : "missed_call_immediate";
    const sent = await sendTemplate(from, template);
    console.log(`[missed-call] ${from} -> ${template} ${sent.ok ? "sent" : "FAILED"}`);
    return json(res, sent.ok ? 200 : 502, { sent: sent.ok, template });
  }

  // Inbound: the caller replied. A reply opens a 24h service window, so from
  // here on plain text is allowed and no template is needed.
  if (req.method === "POST" && url.pathname === "/webhook") {
    const body = await readBody(req);
    res.writeHead(200); res.end(); // ack fast; Meta retries on slow responses

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          if (msg.type !== "text") continue;
          const from = `+${msg.from}`;
          const text = msg.text.body;
          const urgent = EMERGENCY.test(text);

          console.log(`[reply] ${from}${urgent ? " URGENT" : ""}: ${text}`);

          const ack = urgent
            ? templates._freeform_replies.emergency_acknowledge
            : templates._freeform_replies.acknowledge;
          await sendText(from, ack.replace("{{1}}", env.OWNER_NAME));

          // The whole point: the owner gets the lead where he'll actually see
          // it, without having to open an app or a dashboard.
          await sendText(
            env.OWNER_WHATSAPP,
            `${urgent ? "URGENT — " : ""}Missed call reply\n${from}\n\n"${text}"`
          );
        }
      }
    }
    return;
  }

  json(res, 404, { error: "not found" });
});

const port = Number(env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`missed-call-textback listening on :${port}`);
  console.log(`  POST /missed-call  { "from": "+91...", "afterHours": false }`);
  console.log(`  GET/POST /webhook  (point Meta here)`);
});
