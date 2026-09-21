/**
 * Missed-call textback for a one-person trade business.
 *
 *   POST /missed-call   auth'd endpoint for the phone automation (MacroDroid/
 *                       Tasker) to call the instant a call goes unanswered
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
import { log, logError } from "./lib/logger.mjs";
import { handleHealth } from "./routes/health.mjs";
import { handleMissedCall } from "./routes/missedCall.mjs";
import { verifyWebhookGet, handleWebhookPost } from "./routes/webhook.mjs";
import { handleLanding, handleDashboard, handleLeadStatus, handleLogin, handleLogout } from "./routes/dashboard.mjs";

import templates from "./templates.json" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));

export function buildApp(config) {
  const store = createStore(path.join(config.DATA_DIR, "db.json"));
  const wa = createWhatsAppClient(config);
  const deps = { config, store, wa, templates };

  /** Dispatches one request. Returns { status, body? , rawText?, afterAck? }. */
  async function handle(ctx) {
    if (ctx.method === "GET" && ctx.pathname === "/health") {
      return handleHealth();
    }
    if (ctx.method === "GET" && ctx.pathname === "/webhook") {
      return verifyWebhookGet(ctx, deps);
    }
    if (ctx.method === "POST" && ctx.pathname === "/webhook") {
      return handleWebhookPost(ctx, deps);
    }
    if (ctx.method === "POST" && ctx.pathname === "/missed-call") {
      return handleMissedCall(ctx, deps);
    }
    if (ctx.method === "GET" && ctx.pathname === "/") {
      return handleLanding(ctx, deps);
    }
    if (ctx.method === "GET" && ctx.pathname === "/leads") {
      return handleDashboard(ctx, deps);
    }
    if (ctx.method === "POST" && ctx.pathname === "/leads/status") {
      return handleLeadStatus(ctx, deps);
    }
    if (ctx.method === "POST" && ctx.pathname === "/login") {
      return handleLogin(ctx, deps);
    }
    if (ctx.method === "POST" && ctx.pathname === "/logout") {
      return handleLogout(ctx, deps);
    }
    return { status: 404, body: { error: "not found" } };
  }

  return { handle, store, wa, deps };
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
      const NON_JSON_POSTS = new Set(["/webhook", "/login", "/logout", "/leads/status"]);
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
