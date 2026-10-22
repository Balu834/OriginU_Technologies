/**
 * Missed-call textback for a one-person trade business.
 *
 *   POST /missed-call   auth'd endpoint for the phone automation (MacroDroid/
 *                       Tasker) to call the instant a call goes unanswered
 *   GET|POST /ivr/missed-call  the same, for IVR/cloud-telephony providers:
 *                       key as ?key= or Bearer, caller in their own field names
 *   GET  /webhook       Meta's verification handshake
 *   POST /webhook       inbound WhatsApp events — replies drive a short
 *                       conversation that fills in the lead, then notifies
 *                       the owner on WhatsApp
 *   GET  /health        liveness check
 *
 * Zero dependencies by design — see ../voice-agent for the premium/future
 * product; this is the ship-it-today MVP. Route handlers in routes/ are
 * plain functions over an injected `deps` object so they're testable
 * without a live HTTP server or real Meta credentials (see test/).
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, findMissingConfig } from "./config.mjs";
import { createStore } from "./lib/store.mjs";
import { createWhatsAppClient } from "./lib/whatsapp.mjs";
import { loadBusinessRegistry } from "./lib/businesses.mjs";
import { createIntegrationService } from "./lib/integrations.mjs";
import { createAccountService } from "./lib/users.mjs";
import { createMetaVerifier } from "./lib/metaVerify.mjs";
import { embeddedSignupConfig, createEmbeddedSignupClient } from "./lib/embeddedSignup.mjs";
import { createBillingService } from "./lib/billing.mjs";
import { createUsageService } from "./lib/usage.mjs";
import { razorpayConfig, createRazorpayClient } from "./lib/razorpay.mjs";
import { log, logError } from "./lib/logger.mjs";
import { dispatch, NON_JSON_POSTS } from "./routes/router.mjs";
import { handleMissedCall, handleIvrMissedCall } from "./routes/missedCall.mjs";
import { verifyWebhookGet, handleWebhookPost } from "./routes/webhook.mjs";

import templates from "./templates.json" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));

export function buildApp(config) {
  const rzpConfig = razorpayConfig(process.env);
  const store = createStore(path.join(config.DATA_DIR, "db.json"));
  const wa = createWhatsAppClient(config);
  const baseDeps = { config, store, wa, templates };

  // Only wired when the Meta app is actually configured for Embedded
  // Signup. A null client is what makes the settings page offer Advanced
  // Setup instead of a Connect button that could not complete.
  const signup = embeddedSignupConfig(config);
  const embeddedSignup = signup.available
    ? createEmbeddedSignupClient({
        appId: signup.appId,
        appSecret: config.META_APP_SECRET,
        graphVersion: signup.graphVersion,
        registerPin: config.WHATSAPP_REGISTER_PIN,
      })
    : null;

  /** Dispatches one request via the shared route table (routes/router.mjs). */
  async function handle(ctx) {
    const deps = {
      ...baseDeps,
      businesses: await loadBusinessRegistry(store, config),
      integrations: createIntegrationService(store, config),
      accounts: createAccountService(store),
      metaVerifier: createMetaVerifier(),
      embeddedSignup,
      billing: createBillingService(store),
      usage: createUsageService(store),
      razorpay: rzpConfig,
      razorpayClient: createRazorpayClient(rzpConfig),
    };
    if (ctx.method === "GET" && ctx.pathname === "/webhook") return verifyWebhookGet(ctx, deps);
    if (ctx.method === "POST" && ctx.pathname === "/webhook") return handleWebhookPost(ctx, deps);
    if (ctx.method === "POST" && ctx.pathname === "/missed-call") return handleMissedCall(ctx, deps);
    if ((ctx.method === "GET" || ctx.method === "POST") && ctx.pathname === "/ivr/missed-call") return handleIvrMissedCall(ctx, deps);
    return (await dispatch(ctx, deps)) ?? { status: 404, body: { error: "not found" } };
  }

  return { handle, store, wa, deps: baseDeps };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function startServer(config, app) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const rawBody = req.method === "POST" ? await readRawBody(req) : Buffer.alloc(0);
      let json = {};
      if (req.method === "POST") {
        try {
          json = JSON.parse(rawBody.toString("utf8") || "{}");
        } catch {
          json = null; // malformed JSON — routes decide how to respond
        }
      }

      const ctx = {
        method: req.method,
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        rawBody,
        json,
      };

      // /webhook verifies a signature over the raw bytes, and the dashboard
      // forms post url-encoded rather than JSON — none of them want this guard.
      if (req.method === "POST" && json === null && !NON_JSON_POSTS.has(ctx.pathname)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "malformed JSON body" }));
      }

      const result = await app.handle(ctx);

      const headers = { ...(result.headers ?? {}) };
      if (result.html !== undefined) {
        res.writeHead(result.status, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        res.end(result.html);
      } else if (result.rawText !== undefined) {
        res.writeHead(result.status, { ...headers, "Content-Type": "text/plain" });
        res.end(result.rawText);
      } else {
        res.writeHead(result.status, { ...headers, "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body ?? {}));
      }

      if (result.afterAck) {
        result.afterAck().catch((err) => logError("afterAck_error", err, {}));
      }
    } catch (err) {
      logError("unhandled_request_error", err, {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  server.listen(config.PORT, () => {
    log("server_started", { port: config.PORT });
    console.log(`missed-call-textback listening on :${config.PORT}`);
    console.log(`  POST /missed-call  (Authorization: Bearer <MISSED_CALL_API_KEY>)`);
    console.log(`  GET/POST /webhook  (point Meta here)`);
    console.log(`  GET /health`);
  });

  return server;
}

const isMain = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const config = loadConfig(process.env, here);
  const missing = findMissingConfig(config);
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  const app = buildApp(config);
  startServer(config, app);
}
