import test from "node:test";
import assert from "node:assert/strict";
import { isEmergency } from "../lib/emergency.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { createTestDeps } from "./helpers.mjs";

const EMERGENCY_MESSAGES = [
  "There is smoke coming from the switch",
  "The socket is sparking",
  "Water is leaking near the electrical panel",
];

test("emergency signals are detected", () => {
  for (const msg of EMERGENCY_MESSAGES) {
    assert.equal(isEmergency(msg), true, msg);
  }
});

test("non-emergency messages are not flagged", () => {
  assert.equal(isEmergency("AC not cooling"), false);
  assert.equal(isEmergency("Need a fan installed"), false);
});

for (const msg of EMERGENCY_MESSAGES) {
  test(`emergency reply gives safety guidance only, never a diagnosis: "${msg}"`, async () => {
    const deps = createTestDeps();
    const from = "+919876543210";

    const result = await handleInboundMessage({ from, text: msg }, deps);
    assert.equal(result.emergency, true);

    const toCustomer = deps.wa.sent.find((m) => m.to === from);
    assert.ok(toCustomer, "customer should get a reply");
    assert.match(toCustomer.body, /mains/i);
    assert.doesNotMatch(toCustomer.body, /replace|repair|rewire|fix the|it's likely|probably a/i);

    const toOwner = deps.wa.sent.find((m) => m.to === deps.config.MOHAMED_WHATSAPP_NUMBER);
    assert.ok(toOwner, "owner should be notified immediately, even with an incomplete lead");
    assert.match(toOwner.body, /URGENT/);
  });
}
