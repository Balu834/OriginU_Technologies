/**
 * The Vercel wrappers and server.mjs must hand routes/ the same ctx shape.
 *
 * A wrapper that omitted `query` made every dashboard filter a silent
 * no-op in production while every local test passed — the filters worked
 * against server.mjs and were ignored on Vercel. These assert the adapter
 * builds the full shape, so that divergence can't recur unnoticed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ctxFromRequest } from "../api/_deps.mjs";

function fakeReq(url, method = "GET") {
  return { url, method, headers: { host: "example.com", cookie: "a=1" } };
}

test("ctxFromRequest exposes query parameters", () => {
  const ctx = ctxFromRequest(fakeReq("/leads?q=kukatpally&status=new&urgency=urgent"));
  assert.equal(ctx.query.get("q"), "kukatpally");
  assert.equal(ctx.query.get("status"), "new");
  assert.equal(ctx.query.get("urgency"), "urgent");
});

test("ctxFromRequest carries method, pathname and headers", () => {
  const ctx = ctxFromRequest(fakeReq("/leads?x=1", "GET"));
  assert.equal(ctx.method, "GET");
  assert.equal(ctx.pathname, "/leads");
  assert.equal(ctx.headers.cookie, "a=1");
});

test("ctxFromRequest survives a bare path and missing host", () => {
  const ctx = ctxFromRequest({ url: "/leads", method: "GET", headers: {} });
  assert.equal(ctx.pathname, "/leads");
  assert.equal(ctx.query.get("q"), null);
});

test("ctxFromRequest carries the raw body through untouched", () => {
  const body = Buffer.from("password=secret");
  const ctx = ctxFromRequest(fakeReq("/login", "POST"), body);
  assert.equal(ctx.rawBody.toString(), "password=secret");
});

test("query.get on a ctx with no params returns null, not a throw", () => {
  const ctx = ctxFromRequest(fakeReq("/leads"));
  assert.doesNotThrow(() => ctx.query.get("status"));
  assert.equal(ctx.query.get("status"), null);
});
