/**
 * Wires up the same `deps` object routes/ already expect, for Vercel's
 * serverless environment: config from process.env directly (no .env file
 * on Vercel — values are set as project environment variables), and the
 * Redis-backed store instead of the JSON file (no persistent disk here).
 */
import { loadConfig, findMissingConfig } from "../config.mjs";
import { createRedisStore } from "../lib/store.redis.mjs";
import { createWhatsAppClient } from "../lib/whatsapp.mjs";
import { createBusinessRegistry, businessFromConfig } from "../lib/businesses.mjs";
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
  const businesses = createBusinessRegistry([businessFromConfig(config)]);
  cached = { config, store, wa, templates, businesses };
  return cached;
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
