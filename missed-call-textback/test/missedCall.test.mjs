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
