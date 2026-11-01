/**
 * Every browser route must be reachable in production.
 *
 * routes/router.mjs is the dispatch table both environments share, but
 * Vercel only ever sees a path that vercel.json rewrites to a function.
 * Adding a route to the table and forgetting the rewrite produces a route
 * that works perfectly locally and 404s in production — which is exactly
 * what happened to /settings/billing, and is the same class of drift that
 * once made every dashboard filter a silent no-op.
 *
 * This reads both files and compares them, so the two cannot separate
 * again without a test failing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const routerSource = fs.readFileSync(path.join(root, "routes", "router.mjs"), "utf8");

/** The paths in the ROUTES table, read from the source rather than imported, so a typo in a literal is visible. */
function routerPaths() {
  const paths = new Set();
  for (const m of routerSource.matchAll(/\["(GET|POST)",\s*"([^"]+)"/g)) paths.add(m[2]);
  return paths;
}

const rewrites = new Map(vercel.rewrites.map((r) => [r.source, r.destination]));

test("every route in the dispatch table has a vercel.json rewrite", () => {
  const missing = [...routerPaths()].filter((p) => !rewrites.has(p));
  assert.deepEqual(missing, [], `these routes would 404 in production: ${missing.join(", ")}`);
});

test("every browser rewrite points at the shared app function", () => {
  // The externally-called endpoints keep their own functions — they are
  // called by Meta, Razorpay and the phone automation, must read a raw
  // body to verify a signature, and should not share a failure mode with
  // the browser pages. Everything else goes through the shared dispatcher.
  const ownFunction = {
    "/health": "/api/health",
    "/missed-call": "/api/missed-call",
    "/ivr/missed-call": "/api/ivr-missed-call",
    "/webhook": "/api/webhook",
    "/qr/events": "/api/qr-events",
    "/razorpay-webhook": "/api/razorpay-webhook",
  };

  for (const [source, destination] of rewrites) {
    const expected = ownFunction[source] ?? "/api/app";
    assert.equal(destination, expected, `${source} routes to ${destination}, expected ${expected}`);
  }
});

test("no rewrite points at a path the dispatch table cannot serve", () => {
  const known = routerPaths();
  const orphans = [...rewrites.keys()]
    .filter((p) => rewrites.get(p) === "/api/app" && !known.has(p));
  assert.deepEqual(orphans, [], `rewritten to the app but not routable: ${orphans.join(", ")}`);
});

test("the deployment stays under Vercel's Hobby function cap", () => {
  const functions = fs.readdirSync(path.join(root, "api")).filter((f) => f.endsWith(".js"));
  assert.ok(functions.length <= 12, `${functions.length} serverless functions, Hobby allows 12`);
});
