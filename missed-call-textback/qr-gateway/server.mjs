/**
 * MissedCall QR gateway: holds WhatsApp linked-device sessions open.
 *
 * UNOFFICIAL. See README.md before running this for anyone.
 *
 *   GET  /health             liveness + session counts (no business data)
 *   POST /sessions/start     { businessId, mode: "qr"|"code", phone? }
 *   POST /sessions/status    { businessId }  -> state, QR image, pairing code
 *   POST /sessions/send      { businessId, to, text }
 *   POST /sessions/logout    { businessId }
 *
 * Every POST must be signed by the MissedCall app (lib/qrSigning.mjs) and
 * carry a fresh `requestId`, so a captured request can't be replayed to
 * resend a message. Events go the other way through lib/forward.mjs.
 *
 * Runs on Fly.io. With more than one machine, a request for a business
 * whose session lives on another machine is handed to it with Fly's
 * `fly-replay` header.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyQrRequest, QR_SIGNATURE_HEADER } from "../lib/qrSigning.mjs";
import { isValidEncryptionKey } from "../lib/crypto.mjs";
import { createRedis } from "./lib/redis.mjs";
import { createSessionManager } from "./lib/sessions.mjs";
import { createForwarder } from "./lib/forward.mjs";

const BUSINESS_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const REPLAY_WINDOW_MS = 10 * 60 * 1000;

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

/**
 * The request handler, separate from the HTTP server so tests can call it.
 * `onFly` turns "session is on another machine" into a fly-replay header.
 */
export function createGatewayHandler({ manager, secret, onFly = false, now = () => Date.now() }) {
  const seen = new Map();

  function freshRequest(id) {
    const t = now();
    for (const [k, at] of seen) if (t - at > REPLAY_WINDOW_MS) seen.delete(k); else break;
    if (seen.has(id)) return false;
    seen.set(id, t);
    return true;
  }

  return async function handle({ method, path: route, headers = {}, rawBody = Buffer.alloc(0) }) {
    if (method === "GET" && route === "/health") {
      return {
        status: 200,
        body: {
          ok: true,
          sessions: manager.size,
          connected: manager.connectedCount(),
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
        },
      };
    }

    const action = /^\/sessions\/(start|status|send|logout)$/.exec(route)?.[1];
    if (method !== "POST" || !action) return { status: 404, body: { error: "not found" } };

    if (!verifyQrRequest(rawBody, headers[QR_SIGNATURE_HEADER], secret, now())) {
      log("gateway_bad_signature", { route });
      return { status: 401, body: { error: "bad signature" } };
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      return { status: 400, body: { error: "malformed JSON" } };
    }
    const businessId = String(body.businessId ?? "");
    if (!BUSINESS_ID.test(businessId)) return { status: 400, body: { error: "bad businessId" } };
    if (!REQUEST_ID.test(String(body.requestId ?? ""))) return { status: 400, body: { error: "requestId required" } };
    if (!freshRequest(body.requestId)) return { status: 409, body: { error: "duplicate request" } };

    // A session held by another machine is that machine's to answer.
    const owner = await manager.ownerOf(businessId);
    if (owner && owner !== "self") {
      if (onFly) return { status: 409, headers: { "fly-replay": `instance=${owner}` }, body: { error: "elsewhere" } };
      return { status: 409, body: { error: "session is held by another gateway instance" } };
    }

    switch (action) {
      case "start": {
        const result = await manager.start(businessId, { mode: body.mode === "code" ? "code" : "qr", phone: body.phone });
        if (!result.ok && result.code === "elsewhere" && onFly) {
          return { status: 409, headers: { "fly-replay": `instance=${result.owner}` }, body: { error: "elsewhere" } };
        }
        return { status: result.ok ? 200 : 400, body: result };
      }
      case "status":
        return { status: 200, body: { ok: true, status: await manager.status(businessId) } };
      case "send": {
        const result = await manager.send(businessId, { to: body.to, text: body.text });
        return { status: result.ok ? 200 : 422, body: result };
      }
      case "logout":
        return { status: 200, body: await manager.logout(businessId) };
    }
    return { status: 404, body: { error: "not found" } };
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function main() {
  const env = process.env;
  const missing = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "INTEGRATION_ENCRYPTION_KEY", "QR_GATEWAY_SECRET", "MISSEDCALL_APP_URL"]
    .filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!isValidEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY)) {
    console.error("INTEGRATION_ENCRYPTION_KEY must be the same 64-hex-character key the app uses");
    process.exit(1);
  }
  if (env.QR_GATEWAY_SECRET.length < 32) {
    console.error("QR_GATEWAY_SECRET must be at least 32 characters");
    process.exit(1);
  }

  // Loaded here, not at the top, so the tests never need a WhatsApp library.
  const baileysModule = await import("@whiskeysockets/baileys");
  const makeWASocket = baileysModule.default?.default ?? baileysModule.default ?? baileysModule.makeWASocket;
  const { Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, proto } = baileysModule;
  const QRCode = (await import("qrcode")).default;
  const pino = (await import("pino")).default;
  // Baileys logs message contents at debug level. Warnings only.
  const waLogger = pino({ level: env.BAILEYS_LOG_LEVEL || "warn" });

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // Baileys falls back to its bundled version
  }

  const instanceId = env.FLY_MACHINE_ID || os.hostname();
  const redis = createRedis({ url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN });

  const manager = createSessionManager({
    redis,
    encryptionKey: env.INTEGRATION_ENCRYPTION_KEY,
    baileys: { initAuthCreds, proto },
    instanceId,
    log,
    maxSendsPerHour: Number(env.QR_MAX_SENDS_PER_HOUR || 60),
    forward: createForwarder({ appUrl: env.MISSEDCALL_APP_URL, secret: env.QR_GATEWAY_SECRET }),
    qrToDataUrl: (qr) => QRCode.toDataURL(qr, { margin: 1, width: 280 }),
    makeSocket: ({ auth }) =>
      makeWASocket({
        auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, waLogger) },
        version,
        logger: waLogger,
        // Shows as "Chrome (Ubuntu)" in the owner's Linked devices list;
        // the settings page tells them so.
        browser: Browsers.ubuntu("Chrome"),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        // No chat history: we only need new messages, and pulling the
        // owner's whole history would mean holding their private chats.
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
      }),
  });

  const handle = createGatewayHandler({ manager, secret: env.QR_GATEWAY_SECRET, onFly: Boolean(env.FLY_MACHINE_ID) });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://gateway");
      const rawBody = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
      const result = await handle({ method: req.method, path: url.pathname, headers: req.headers, rawBody });
      res.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
      res.end(JSON.stringify(result.body ?? {}));
    } catch (err) {
      log("gateway_request_error", { error: err.message });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  const port = Number(env.PORT || 8080);
  server.listen(port, () => log("gateway_started", { port, instanceId }));

  const lockTimer = setInterval(() => manager.renewLocks().catch((err) => log("lock_renew_failed", { error: err.message })), 20_000);
  manager.restoreAll()
    .then((n) => log("sessions_restored", { count: n }))
    .catch((err) => log("restore_failed", { error: err.message }));

  let closing = false;
  const stop = async (signal) => {
    if (closing) return;
    closing = true;
    log("gateway_stopping", { signal });
    clearInterval(lockTimer);
    server.close();
    await manager.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

const isMain = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
