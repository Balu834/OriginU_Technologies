/**
 * Missed-call requests set up by hand on a business owner's phone.
 *
 * The first real MacroDroid setup (19 Nov 2026) hit, one after another: a
 * trailing space the keyboard added to a field name, curly quotes in the
 * JSON body, and a caller-number field MissedCall did not recognise. Each
 * time MissedCall answered 400 and logged nothing that said why. These pin
 * that a request typed on a phone is read the way it was meant, that the
 * fallback never guesses between two numbers or reads the key as one, and
 * that a request that still fails says which field names arrived.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleMissedCall, handleIvrMissedCall, findCallerNumber } from "../routes/missedCall.mjs";
import { createTestDeps } from "./helpers.mjs";

const KEY = "test-missed-call-key";

/** /ivr/missed-call: query params plus an optional raw body. */
function ivrCtx({ method = "POST", query = {}, headers = {}, body = "", contentType = "" } = {}) {
  const h = { ...headers };
  if (contentType) h["content-type"] = contentType;
  return { method, pathname: "/ivr/missed-call", query: new URLSearchParams(query), headers: h, rawBody: Buffer.from(body), json: {} };
}

/** /missed-call as the Vercel wrapper builds it: json is null when the body is not JSON. */
function phoneCtx({ body = "", contentType = "application/json", query = {}, auth = `Bearer ${KEY}` } = {}) {
  let json = null;
  try { json = JSON.parse(body || "{}"); } catch { json = null; }
  return {
    method: "POST", pathname: "/missed-call", query: new URLSearchParams(query),
    headers: { authorization: auth, "content-type": contentType }, rawBody: Buffer.from(body), json,
  };
}

function captureLogs() {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

// ------------------------------------------------------------ field names

test("a field name with the keyboard's trailing space still finds the caller and the key", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({ query: { "key ": KEY, "callerNumber ": "+917997878834" } }), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+917997878834");
});

test("capitals, spaces and underscores in a field name don't matter", async () => {
  for (const name of ["Caller Number", "CALLERNUMBER", "caller_number", "Caller", "Mobile "]) {
    const deps = createTestDeps();
    const res = await handleIvrMissedCall(ivrCtx({ query: { Key: KEY, [name]: "9876543210" } }), deps);
    assert.equal(res.status, 200, name);
    assert.equal(deps.wa.sent[0].to, "+919876543210", name);
  }
});

test("an unrecognised field holding the only phone number is used", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({ query: { key: KEY, phone: "09876543210" } }), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("two unrecognised phone numbers are never guessed between", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({ query: { key: KEY, a: "9876543210", b: "9123456780" } }), deps);
  assert.equal(res.status, 400);
  assert.equal(deps.wa.sent.length, 0);
});

test("a timestamp, a date or a call id is never taken for a phone number", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({
    query: { key: KEY, StartTime: "1795075232", date: "2026-11-19", CallSid: "8123456789012345" },
  }), deps);
  assert.equal(res.status, 400);
  assert.equal(deps.wa.sent.length, 0);
});

test("the business's own line (To) is never taken for the caller", () => {
  assert.equal(findCallerNumber(new Map([["To", "+919885536488"]])), null);
  assert.equal(findCallerNumber(new Map([["To", "+919885536488"], ["from ", "9876543210"]])), "+919876543210");
});

test("digits inside the key are never read as a phone number", async () => {
  const deps = createTestDeps({ MISSED_CALL_API_KEY: "mc_98765432101234" });
  const res = await handleIvrMissedCall(ivrCtx({ query: { key: "mc_98765432101234" } }), deps);
  assert.equal(res.status, 400);
  assert.equal(deps.wa.sent.length, 0);
});

test("an empty field never hides a filled one of the same name", async () => {
  const deps = createTestDeps();
  const res = await handleIvrMissedCall(ivrCtx({
    query: { key: KEY, callerNumber: "+919876543210" },
    body: '{"callerNumber":""}', contentType: "application/json",
  }), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

// ------------------------------------------------------- the JSON route

test("curly quotes from a phone keyboard don't break the JSON body", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(phoneCtx({ body: "{\u201CcallerNumber\u201D:\u201C+919876543210\u201D}" }), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("a form body on the JSON route is read instead of refused", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(phoneCtx({ body: "callerNumber=9876543210", contentType: "application/x-www-form-urlencoded" }), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("a JSON key with a trailing space is read on the JSON route", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(phoneCtx({ body: '{"callerNumber ":"09876543210"}' }), deps);
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("the JSON route still needs its key, whatever the body", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(phoneCtx({ body: "callerNumber=9876543210", auth: "" }), deps);
  assert.equal(res.status, 401);
  assert.equal(deps.wa.sent.length, 0);
});

// --------------------------------------------------------------- the log

test("a request with no readable caller logs the field names that arrived, never their values", async () => {
  const deps = createTestDeps();
  const logs = captureLogs();
  let res;
  try {
    res = await handleIvrMissedCall(ivrCtx({ query: { key: KEY, "calerNumbr ": "[call_number]" } }), deps);
  } finally {
    logs.restore();
  }
  assert.equal(res.status, 400);
  const line = logs.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e?.event === "missed_call_bad_number");
  assert.ok(line, "the failure was logged");
  assert.deepEqual(line.fieldNames, ['"key"', '"calerNumbr "']);
  assert.equal(line.phoneShapedValues, 0);
  const all = logs.lines.join("\n");
  assert.ok(!all.includes(KEY), "the key reached the log");
  assert.ok(!all.includes("[call_number]"), "a value reached the log");
});
