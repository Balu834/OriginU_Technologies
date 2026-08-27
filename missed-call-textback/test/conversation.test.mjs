import test from "node:test";
import assert from "node:assert/strict";
import { extractFields } from "../lib/extract.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { createTestDeps } from "./helpers.mjs";

test("extracts a single problem field", () => {
  assert.deepEqual(extractFields("AC not cooling"), { problem: "AC not cooling" });
});

test("extracts name and area together", () => {
  const found = extractFields("I'm Ravi from Whitefield");
  assert.equal(found.name, "Ravi");
  assert.equal(found.area, "Whitefield");
});

test("extracts urgency", () => {
  assert.equal(extractFields("Need someone today").urgency, "today");
});

test("extracts all four fields from one combined message", () => {
  const found = extractFields("I'm Ravi from Whitefield and my AC isn't cooling. Need someone today.");
  assert.equal(found.name, "Ravi");
  assert.equal(found.area, "Whitefield");
  assert.equal(found.problem, "AC isn't cooling");
  assert.equal(found.urgency, "today");
});

test("full step-by-step conversation reaches a completed lead without repeating questions", async () => {
  const deps = createTestDeps();
  const from = "+919876543210";

  const r1 = await handleInboundMessage({ from, text: "AC not cooling" }, deps);
  assert.equal(r1.leadCompleted, false);
  let last = deps.wa.sent.at(-1);
  assert.match(last.body, /area/i);

  const r2 = await handleInboundMessage({ from, text: "Whitefield" }, deps);
  assert.equal(r2.leadCompleted, false);
  last = deps.wa.sent.at(-1);
  assert.match(last.body, /name/i);

  const r3 = await handleInboundMessage({ from, text: "Ravi" }, deps);
  assert.equal(r3.leadCompleted, false);
  last = deps.wa.sent.at(-1);
  assert.match(last.body, /today/i);

  const r4 = await handleInboundMessage({ from, text: "Need someone today" }, deps);
  assert.equal(r4.leadCompleted, true);
  assert.equal(r4.lead.name, "Ravi");
  assert.equal(r4.lead.area, "Whitefield");
  assert.equal(r4.lead.problem, "AC not cooling");
  assert.equal(r4.lead.urgency, "today");

  const ownerMsg = deps.wa.sent.find((m) => m.to === deps.config.MOHAMED_WHATSAPP_NUMBER);
  assert.ok(ownerMsg, "owner should be notified");
  assert.match(ownerMsg.body, /Name: Ravi/);
  assert.match(ownerMsg.body, /Area: Whitefield/);
  assert.match(ownerMsg.body, /Problem: AC not cooling/);
  assert.match(ownerMsg.body, /Urgency: Today/);
});

test("a combined message completes the lead in one turn, no unnecessary follow-ups", async () => {
  const deps = createTestDeps();
  const from = "+919876543210";

  const result = await handleInboundMessage(
    { from, text: "I'm Ravi from Whitefield and my AC isn't cooling. Need someone today." },
    deps
  );

  assert.equal(result.leadCompleted, true);
  assert.equal(result.lead.name, "Ravi");
  assert.equal(result.lead.area, "Whitefield");
  assert.equal(result.lead.problem, "AC isn't cooling");
  assert.equal(result.lead.urgency, "today");

  const toCustomer = deps.wa.sent.filter((m) => m.to === from);
  assert.equal(toCustomer.length, 1, "only the confirmation should go to the customer, no follow-up questions");
});
