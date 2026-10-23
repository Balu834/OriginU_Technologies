import test from "node:test";
import assert from "node:assert/strict";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { createTestDeps, jsonCtx } from "./helpers.mjs";

const AUTH = { authorization: "Bearer test-missed-call-key" };

test("valid missed-call request sends the template", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({
      method: "POST",
      pathname: "/missed-call",
      headers: AUTH,
      body: { callerNumber: "+919876543210", timestamp: "2026-08-26T10:30:00+05:30" },
    }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.equal(deps.wa.sent.length, 1);
  assert.equal(deps.wa.sent[0].kind, "template");
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("missing callerNumber is rejected", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body: { timestamp: "2026-08-26T10:30:00Z" } }),
    deps
  );
  assert.equal(res.status, 400);
  assert.equal(deps.wa.sent.length, 0);
});

test("invalid callerNumber is rejected", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({
      method: "POST",
      pathname: "/missed-call",
      headers: AUTH,
      body: { callerNumber: "98765", timestamp: "2026-08-26T10:30:00Z" },
    }),
    deps
  );
  assert.equal(res.status, 400);
});

test("missing Authorization header is rejected", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({
      method: "POST",
      pathname: "/missed-call",
      body: { callerNumber: "+919876543210", timestamp: "2026-08-26T10:30:00Z" },
    }),
    deps
  );
  assert.equal(res.status, 401);
  assert.equal(deps.wa.sent.length, 0);
});

test("wrong API key is rejected", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({
      method: "POST",
      pathname: "/missed-call",
      headers: { authorization: "Bearer nope" },
      body: { callerNumber: "+919876543210", timestamp: "2026-08-26T10:30:00Z" },
    }),
    deps
  );
  assert.equal(res.status, 401);
});

test("duplicate missed-call within the dedupe window is not resent", async () => {
  const deps = createTestDeps();
  const body = { callerNumber: "+919876543210", timestamp: "2026-08-26T10:30:00Z" };
  const first = await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);
  const second = await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);

  assert.equal(first.body.sent, true);
  assert.equal(second.body.deduped, true);
  assert.equal(deps.wa.sent.length, 1, "template should only be sent once");
});

test("a failed WhatsApp send does not block an immediate retry", async () => {
  const deps = createTestDeps();
  deps.wa.sendTemplate = () => Promise.resolve({ ok: false, status: 500, body: {} });
  const body = { callerNumber: "+919876543210", timestamp: "2026-08-26T10:30:00Z" };

  const failed = await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);
  assert.equal(failed.status, 502);

  let retried = false;
  deps.wa.sendTemplate = () => {
    retried = true;
    return Promise.resolve({ ok: true, status: 200, body: {} });
  };
  const second = await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);
  assert.equal(retried, true, "the retry must actually attempt to send, not get silently deduped");
  assert.equal(second.body.sent, true);
});

test("Mohamed's own number is ignored", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({
      method: "POST",
      pathname: "/missed-call",
      headers: AUTH,
      body: { callerNumber: deps.config.MOHAMED_WHATSAPP_NUMBER, timestamp: "2026-08-26T10:30:00Z" },
    }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, false);
  assert.equal(deps.wa.sent.length, 0);
});

// ------------------------------------------------ MacroDroid number formats

function captureLogs() {
  const lines = [];
  const { log } = console;
  console.log = (...a) => lines.push(a.join(" "));
  return { events: () => lines.map((l) => JSON.parse(l)), restore: () => { console.log = log; } };
}

test("a 10-digit caller number from MacroDroid is accepted as +91", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body: { callerNumber: "9876543210" } }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("a 0-prefixed caller number from MacroDroid is accepted as +91", async () => {
  const deps = createTestDeps();
  const res = await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body: { callerNumber: "09876543210" } }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(deps.wa.sent[0].to, "+919876543210");
});

test("a rejected key is logged, without any key material", async () => {
  const deps = createTestDeps();
  const logs = captureLogs();
  try {
    await handleMissedCall(
      jsonCtx({ method: "POST", pathname: "/missed-call", headers: { authorization: "Bearer wrong-key-value" }, body: { callerNumber: "+919876543210" } }),
      deps
    );
    await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", body: { callerNumber: "+919876543210" } }), deps);
  } finally {
    logs.restore();
  }
  const events = logs.events().filter((e) => e.event === "missed_call_unauthorized");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.hadCredential), [true, false]);
  for (const e of events) assert.ok(!JSON.stringify(e).includes("wrong-key-value"), "the key reached the log");
});

test("an unreadable caller number is logged, masked", async () => {
  const deps = createTestDeps();
  const logs = captureLogs();
  let res;
  try {
    res = await handleMissedCall(
      jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body: { callerNumber: "98765abc" } }),
      deps
    );
  } finally {
    logs.restore();
  }
  assert.equal(res.status, 400);
  const [event] = logs.events().filter((e) => e.event === "missed_call_bad_number");
  assert.ok(event, "the bad number was not logged");
  assert.equal(event.route, "/missed-call");
  assert.equal(event.callerNumber, "987**abc");
});

test("an owner number stored without a country code is still ignored", async () => {
  // A business saved before owner numbers were normalised holds "9110819125";
  // the call arrives as "+919110819125" and must still match it.
  const deps = createTestDeps({ MOHAMED_WHATSAPP_NUMBER: "9110819125" });
  const res = await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body: { callerNumber: "+919110819125" } }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, "ignored own number");
  assert.equal(deps.wa.sent.length, 0);
});
