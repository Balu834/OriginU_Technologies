/**
 * Durability of what the customer told us.
 *
 * These assert the *data survives*, which is a stronger bar than the
 * failure-mode suite's "doesn't throw". The webhook marks a message id
 * processed before handing it to the conversation engine, so Meta's retry
 * of that same message is skipped as a duplicate — anything lost because
 * an outbound send failed is lost permanently, with no second chance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { dashboardPage } from "../lib/views.mjs";
import { createTestDeps } from "./helpers.mjs";

test("a failed outbound question still persists what the customer just said", async () => {
  const deps = createTestDeps();
  deps.wa.sendText = () => Promise.reject(new Error("WhatsApp unavailable"));

  await assert.rejects(() => handleInboundMessage({ from: "+919000000001", text: "AC not cooling" }, deps));

  const conv = await deps.store.getConversation("+919000000001");
  assert.ok(conv, "conversation must exist even though the reply failed to send");
  assert.equal(conv.fields.problem, "AC not cooling", "the extracted problem must not be lost");
  assert.equal(conv.awaiting, "area", "the pending question must be recorded so the next reply lands correctly");
});

test("a failed confirmation still persists the completed lead", async () => {
  const deps = createTestDeps();
  const from = "+919000000002";

  await handleInboundMessage({ from, text: "AC not cooling" }, deps);
  await handleInboundMessage({ from, text: "Whitefield" }, deps);
  await handleInboundMessage({ from, text: "Ravi" }, deps);

  deps.wa.sendText = () => Promise.reject(new Error("WhatsApp unavailable"));
  await assert.rejects(() => handleInboundMessage({ from, text: "today" }, deps));

  const leads = await deps.store.listLeads();
  assert.equal(leads.length, 1, "the lead must be saved before any outbound send is attempted");
  assert.equal(leads[0].name, "Ravi");
  assert.equal(leads[0].area, "Whitefield");
});

test("a lead whose owner notification fails is recorded as undelivered", async () => {
  const deps = createTestDeps();
  const from = "+919000000003";

  await handleInboundMessage({ from, text: "AC not cooling" }, deps);
  await handleInboundMessage({ from, text: "Whitefield" }, deps);
  await handleInboundMessage({ from, text: "Ravi" }, deps);

  // Customer messages keep succeeding; only the owner alert fails.
  deps.wa.sendText = (to) =>
    to === deps.config.MOHAMED_WHATSAPP_NUMBER
      ? Promise.resolve({ ok: false, status: 500, body: {} })
      : Promise.resolve({ ok: true, status: 200, body: {} });

  const result = await handleInboundMessage({ from, text: "today" }, deps);

  assert.equal(result.leadCompleted, true);
  assert.equal(result.ownerNotified, false);

  const lead = (await deps.store.listLeads())[0];
  assert.equal(lead.ownerNotified, false, "the failure must be recorded on the lead, not swallowed");
});

test("a successfully notified lead is marked delivered", async () => {
  const deps = createTestDeps();
  const from = "+919000000004";
  for (const text of ["AC not cooling", "Whitefield", "Ravi", "today"]) {
    await handleInboundMessage({ from, text }, deps);
  }
  const lead = (await deps.store.listLeads())[0];
  assert.equal(lead.ownerNotified, true);
});

test("the dashboard flags an undelivered lead so it cannot pass unnoticed", () => {
  const html = dashboardPage([
    { id: "u1", callerNumber: "+919000000005", name: "Ravi", problem: "AC not cooling",
      status: "new", ownerNotified: false, createdAt: new Date().toISOString() },
  ]);
  assert.match(html, /failed to send/i);
});

test("a delivered lead shows no failure warning", () => {
  const html = dashboardPage([
    { id: "d1", callerNumber: "+919000000006", name: "Ravi", problem: "AC not cooling",
      status: "new", ownerNotified: true, createdAt: new Date().toISOString() },
  ]);
  assert.doesNotMatch(html, /failed to send/i);
});

test("completing a lead does not produce a second lead for the same conversation", async () => {
  const deps = createTestDeps();
  const from = "+919000000007";
  for (const text of ["AC not cooling", "Whitefield", "Ravi", "today"]) {
    await handleInboundMessage({ from, text }, deps);
  }
  assert.equal((await deps.store.listLeads()).length, 1, "one completed conversation must yield exactly one lead");
});

test("the owner is notified once per completed lead, not once per message", async () => {
  const deps = createTestDeps();
  const from = "+919000000008";
  for (const text of ["AC not cooling", "Whitefield", "Ravi", "today"]) {
    await handleInboundMessage({ from, text }, deps);
  }
  const ownerMessages = deps.wa.sent.filter((m) => m.to === deps.config.MOHAMED_WHATSAPP_NUMBER);
  assert.equal(ownerMessages.length, 1, "four customer messages must not mean four owner alerts");
});
