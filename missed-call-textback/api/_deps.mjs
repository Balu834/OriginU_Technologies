/**
 * Wires up the same `deps` object routes/ already expect, for Vercel's
 * serverless environment: config from process.env directly (no .env file
 * on Vercel — values are set as project environment variables), and the
 * Redis-backed store instead of the JSON file (no persistent disk here).
 */
import { loadConfig, findMissingConfig } from "../config.mjs";
import { createRedisStore } from "../lib/store.redis.mjs";
import { createWhatsAppClient } from "../lib/whatsapp.mjs";
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

/** Reads the full request body into a Buffer. Vercel's request is still a readable stream when bodyParser is disabled. */
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
