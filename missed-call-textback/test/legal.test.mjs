/**
 * The public legal pages. Meta will not publish the app without them, and
 * what they say has to stay true of the product.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../routes/router.mjs";
import { landingPage } from "../lib/landing.mjs";
import { LEGAL_OPERATOR } from "../lib/legalViews.mjs";

const get = (pathname) => dispatch({ method: "GET", pathname, headers: {}, query: {} }, {});

test("privacy, terms and data-deletion load for anyone, with no session and no store", async () => {
  for (const path of ["/privacy", "/terms", "/data-deletion"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const html = String(res.html);
    assert.match(html, /<h1>/, path);
    assert.ok(html.includes(LEGAL_OPERATOR.email), `${path} must say how to reach the operator`);
    assert.ok(html.includes("Lavudiya Balu"), `${path} must name who runs the service`);
  }
});

test("the privacy policy names every processor that actually handles data", async () => {
  const html = String((await get("/privacy")).html);
  for (const processor of ["Meta Platforms", "Vercel", "Upstash", "Razorpay"]) {
    assert.ok(html.includes(processor), `missing ${processor}`);
  }
});

test("the data-deletion page tells both account holders and callers what to do", async () => {
  const html = String((await get("/data-deletion")).html);
  assert.match(html, /If you have a MissedCall account/);
  assert.match(html, /If you received a WhatsApp message/);
  assert.match(html, /within 30 days/);
});

test("no legal page carries the former single tenant's name", async () => {
  for (const path of ["/privacy", "/terms", "/data-deletion"]) {
    assert.doesNotMatch(String((await get(path)).html), /Planet Electrical/);
  }
});

test("the landing page footer links to all three", () => {
  const html = landingPage({ plans: { FREE: { price: "₹0", leads: 25, messages: 100 }, PRO: { price: "₹299", leads: 500, messages: 2000 } } });
  for (const path of ["/privacy", "/terms", "/data-deletion"]) {
    assert.ok(html.includes(`href="${path}"`), `footer is missing ${path}`);
  }
});
