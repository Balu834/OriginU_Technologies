import test from "node:test";
import assert from "node:assert/strict";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { createTestDeps, signBody, jsonCtx } from "./helpers.mjs";

function textMessagePayload({ id = "wamid.DUPLICATE", from = "919876543210", body = "AC not cooling" } = {}) {
  return {
    entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body }, timestamp: "1700000000" }] } }] }],
  };
}

test("the same WhatsApp message id is only processed once, even if Meta retries the webhook", async () => {
  const deps = createTestDeps();
  const rawBody = Buffer.from(JSON.stringify(textMessagePayload()));
  const headers = { "x-hub-signature-256": signBody(rawBody) };

  const first = handleWebhookPost({ rawBody, headers }, deps);
  await first.afterAck();
  const second = handleWebhookPost({ rawBody, headers }, deps);
  await second.afterAck();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(deps.wa.sent.length, 1, "the duplicate delivery must not trigger a second reply");
});

test("a retried /missed-call request for the same caller does not send a second template", async () => {
  const deps = createTestDeps();
  const AUTH = { authorization: "Bearer test-missed-call-key" };
  const body = { callerNumber: "+919876543210", timestamp: "2026-08-26T10:30:00Z" };

  await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);
  await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);
  await handleMissedCall(jsonCtx({ method: "POST", pathname: "/missed-call", headers: AUTH, body }), deps);

  assert.equal(deps.wa.sent.length, 1);
});
