import test from "node:test";
import assert from "node:assert/strict";
import { handleIvrMissedCall } from "../routes/missedCall.mjs";
import { toE164 } from "../lib/phone.mjs";
import { createTestDeps } from "./helpers.mjs";

const KEY = "test-missed-call-key";

/** An IVR request: query params, plus an optional form or JSON body. */
function ivrCtx({ method = "GET", query = {}, headers = {}, form, json } = {}) {
  let rawBody = Buffer.alloc(0);
  const h = { ...headers };
  if (form) {
    rawBody = Buffer.from(new URLSearchParams(form).toString());
    h["content-type"] = "application/x-www-form-urlencoded";
  } else if (json) {
    rawBody = Buffer.from(JSON.stringify(json));
    h["content-type"] = "application/json";
  }
  return { method, pathname: "/ivr/missed-call", query: new URLSearchParams(query), headers: h, rawBody, json: {} };
}

test("Exotel-style GET with ?key and CallFrom sends the template", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({ query: { key: KEY, CallFrom: "09876543210", CallSid: "abc" } }), deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.equal(deps.wa.sent.length, 1);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("form POST with caller_id and a Bearer key sends the template", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(
    ivrCtx({ method: "POST", headers: { authorization: `Bearer ${KEY}` }, form: { caller_id: "919876543210" } }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("JSON POST with callerNumber works too", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(
    ivrCtx({ method: "POST", query: { key: KEY }, json: { callerNumber: "+919876543210" } }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
});

test("a call a person answered is not messaged", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(
    ivrCtx({ query: { key: KEY, CallFrom: "09876543210", DialCallStatus: "completed" } }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, false);
  assert.equal(deps.wa.sent.length, 0);
});

test("an unanswered dial status still sends", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(
    ivrCtx({ query: { key: KEY, CallFrom: "09876543210", DialCallStatus: "no-answer" } }),
    deps
  );
  assert.equal(res.body.sent, true);
});

test("missing or wrong key is rejected", async () => {
  const deps = createTestDeps();
  const none = await handleIvrMissedCall(ivrCtx({ query: { CallFrom: "09876543210" } }), deps);
  const wrong = await handleIvrMissedCall(ivrCtx({ query: { key: "nope", CallFrom: "09876543210" } }), deps);
  assert.equal(none.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(deps.wa.sent.length, 0);
});

test("no readable caller number is a 400", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({ query: { key: KEY, CallFrom: "anonymous" } }), deps);
  assert.equal(res.status, 400);
  assert.equal(deps.wa.sent.length, 0);
});

test("the 10-minute dedupe applies to IVR calls", async () => {
  const deps = createTestDeps();
  const ctx = () => ivrCtx({ query: { key: KEY, From: "+919876543210" } });
  await handleIvrMissedCall(ctx(), deps);
  const second = await handleIvrMissedCall(ctx(), deps);
  assert.equal(second.body.deduped, true);
  assert.equal(deps.wa.sent.length, 1);
});

test("toE164 reads the formats IVR providers send", () => {
  assert.equal(toE164("09876543210"), "+919876543210");
  assert.equal(toE164("9876543210"), "+919876543210");
  assert.equal(toE164("919876543210"), "+919876543210");
  assert.equal(toE164("+91 98765-43210"), "+919876543210");
  assert.equal(toE164("00919876543210"), "+919876543210");
  assert.equal(toE164("+14155550123"), "+14155550123");
  assert.equal(toE164("anonymous"), null);
  assert.equal(toE164(""), null);
  assert.equal(toE164(undefined), null);
});
