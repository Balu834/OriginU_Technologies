import test from "node:test";
import assert from "node:assert/strict";
import { verifyWebhookGet, handleWebhookPost } from "../routes/webhook.mjs";
import { createTestDeps, signBody } from "./helpers.mjs";

function textMessagePayload({ id = "wamid.TEST1", from = "919876543210", body = "AC not cooling" } = {}) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ id, from, type: "text", text: { body }, timestamp: "1700000000" }],
            },
          },
        ],
      },
    ],
  };
}

test("GET webhook verification succeeds with the right token", () => {
  const deps = createTestDeps();
  const query = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "abc123" });
  const res = verifyWebhookGet({ query }, deps);
  assert.equal(res.status, 200);
  assert.equal(res.rawText, "abc123");
});

test("GET webhook verification fails with the wrong token", () => {
  const deps = createTestDeps();
  const query = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "abc123" });
  const res = verifyWebhookGet({ query }, deps);
  assert.equal(res.status, 403);
});

test("POST webhook with a valid signature is accepted and processed", async () => {
  const deps = createTestDeps();
  const rawBody = Buffer.from(JSON.stringify(textMessagePayload()));
  const res = handleWebhookPost(
    { rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } },
    deps
  );
  assert.equal(res.status, 200);
  await res.afterAck();
  assert.equal(deps.wa.sent.length, 1, "should ask the next missing field");
});

test("POST webhook with an invalid signature is rejected", () => {
  const deps = createTestDeps();
  const rawBody = Buffer.from(JSON.stringify(textMessagePayload()));
  const res = handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": "sha256=deadbeef" } }, deps);
  assert.equal(res.status, 403);
  assert.equal(res.afterAck, undefined);
});

test("POST webhook with a malformed payload still acks 200 and does not throw", async () => {
  const deps = createTestDeps();
  const rawBody = Buffer.from("{not valid json");
  const res = handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } }, deps);
  assert.equal(res.status, 200);
  await assert.doesNotReject(() => res.afterAck());
  assert.equal(deps.wa.sent.length, 0);
});
