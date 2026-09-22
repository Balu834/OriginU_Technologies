/**
 * Wires up the same `deps` object routes/ already expect, for Vercel's
 * serverless environment: config from process.env directly (no .env file
 * on Vercel — values are set as project environment variables), and the
 * Redis-backed store instead of the JSON file (no persistent disk here).
 */
import { loadConfig, findMissingConfig } from "../config.mjs";
import { createRedisStore } from "../lib/store.redis.mjs";
import { createWhatsAppClient } from "../lib/whatsapp.mjs";
import { loadBusinessRegistry } from "../lib/businesses.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { createAccountService } from "../lib/users.mjs";
import templates from "../templates.json" with { type: "json" };

let cached = null;

export function getDeps() {
  if (cached) return cached;

  const config = loadConfig(process.env, process.cwd());
  const missing = findMissingConfig(config);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const store = createRedisStore(process.env);
  const wa = createWhatsAppClient(config);
  cached = { config, store, wa, templates };
  return cached;
}

/**
 * Per-request deps including the business registry.
 *
 * The registry is loaded per request rather than cached with the rest of
 * the deps, because businesses are now editable data — a cached registry
 * would serve a stale tenant configuration until the lambda recycled.
 */
export async function getRequestDeps() {
  const base = getDeps();
  const businesses = await loadBusinessRegistry(base.store, base.config);
  const integrations = createIntegrationService(base.store, base.config);
  const accounts = createAccountService(base.store);
  return { ...base, businesses, integrations, accounts };
}

/**
 * Builds the ctx routes/ expect from a Vercel request.
 *
 * server.mjs builds the same shape for local runs. Constructing it here
 * rather than inline in each api/ wrapper keeps the two environments in
 * step — a wrapper that quietly omitted `query` made every dashboard
 * filter a no-op in production while passing locally.
 */
export function ctxFromRequest(req, rawBody = Buffer.alloc(0)) {
  const url = new URL(req.url ?? "/", `http://${req.headers?.host ?? "localhost"}`);
  return {
    method: req.method,
    pathname: url.pathname,
    query: url.searchParams,
    headers: req.headers ?? {},
    rawBody,
  };
}

/**
 * Writes a route result ({ status, html?, rawText?, body?, headers? }) out
 * to a Vercel response, so every api/ wrapper handles HTML pages,
 * redirects and JSON the same way.
 */
export function sendResult(res, result) {
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    res.setHeader(name, value);
  }
  if (result.html !== undefined) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(result.status).send(result.html);
  }
  if (result.rawText !== undefined) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(result.status).send(result.rawText);
  }
  return res.status(result.status).json(result.body ?? {});
}

/** Reads the full request body into a Buffer. Vercel's request is still a readable stream when bodyParser is disabled. */
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
