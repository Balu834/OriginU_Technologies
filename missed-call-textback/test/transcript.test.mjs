/**
 * Conversation transcript storage and the lead detail view.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { handleLeadDetail } from "../routes/dashboard.mjs";
import { leadDetailPage } from "../lib/views.mjs";
import { customerVisible, normaliseMessageType, providerMessageId } from "../lib/messages.mjs";
import { createSession, hashPassword, COOKIE_NAME } from "../lib/auth.mjs";
import { createBusinessRegistry, businessFromConfig } from "../lib/businesses.mjs";
import { createTestDeps, createFakeWa, signBody, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const FROM = "+919505141818";

function tenantDeps() {
  const store = createStore(null);
  return {
    store,
    businesses: createBusinessRegistry([businessFromConfig(TEST_CONFIG)]),
    wa: createFakeWa(),
    templates,
    config: { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw") },
  };
}

test("an inbound customer message is stored with its text and Meta id", async () => {
  const deps = createTestDeps();
  await handleInboundMessage(
    { from: FROM, text: "AC not cooling", messageId: "wamid.IN1", timestamp: "1700000000" },
    deps
  );

  const messages = await deps.store.listMessages(FROM);
  const inbound = messages.find((m) => m.direction === "inbound");
  assert.equal(inbound.text, "AC not cooling");
  assert.equal(inbound.messageId, "wamid.IN1");
  assert.equal(inbound.senderType, "customer");
  assert.equal(inbound.messageType, "text");
});

test("our reply is stored as an outbound assistant message", async () => {
  const deps = createTestDeps();
  await handleInboundMessage({ from: FROM, text: "AC not cooling", messageId: "wamid.IN2" }, deps);

  const outbound = (await deps.store.listMessages(FROM)).filter((m) => m.direction === "outbound");
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].senderType, "assistant");
  assert.match(outbound[0].text, /area/i);
});

test("an accepted send is NOT recorded as delivered", async () => {
  const deps = createTestDeps();
  await handleInboundMessage({ from: FROM, text: "AC not cooling", messageId: "wamid.IN3" }, deps);
  const outbound = (await deps.store.listMessages(FROM)).find((m) => m.direction === "outbound");
  assert.equal(outbound.deliveryStatus, null, "API acceptance is not delivery");
});

test("the full conversation is stored in the order it happened", async () => {
  const deps = createTestDeps();
  const turns = [
    ["AC not cooling", "wamid.A"],
    ["Kukatpally", "wamid.B"],
    ["Balu", "wamid.C"],
    ["today", "wamid.D"],
  ];
  for (const [text, id] of turns) {
    await handleInboundMessage({ from: FROM, text, messageId: id }, deps);
  }

  const visible = customerVisible(await deps.store.listMessages(FROM));
  const inboundTexts = visible.filter((m) => m.direction === "inbound").map((m) => m.text);
  assert.deepEqual(inboundTexts, ["AC not cooling", "Kukatpally", "Balu", "today"]);
  assert.equal(visible[0].senderType, "customer", "the customer speaks first");
  assert.equal(visible[1].senderType, "assistant", "then we answer");
});

test("owner notifications are recorded but kept out of the customer transcript", async () => {
  const deps = createTestDeps();
  for (const [text, id] of [["AC not cooling","w1"],["Kukatpally","w2"],["Balu","w3"],["today","w4"]]) {
    await handleInboundMessage({ from: FROM, text, messageId: id }, deps);
  }

  const all = await deps.store.listMessages(FROM);
  const owner = all.filter((m) => m.senderType === "owner");
  assert.equal(owner.length, 1, "the owner alert is recorded");
  assert.ok(owner[0].leadId, "and linked to the lead");
  assert.ok(!customerVisible(all).some((m) => m.senderType === "owner"),
    "but never shown as part of the customer conversation");
});

test("messages are linked to the lead once one exists", async () => {
  const deps = createTestDeps();
  for (const [text, id] of [["AC not cooling","x1"],["Kukatpally","x2"],["Balu","x3"],["today","x4"]]) {
    await handleInboundMessage({ from: FROM, text, messageId: id }, deps);
  }
  const lead = (await deps.store.listLeads())[0];
  const linked = (await deps.store.listMessages(FROM)).filter((m) => m.leadId === lead.id);
  assert.ok(linked.length >= 2, "the confirmation and owner alert carry the lead id");
});

test("a duplicate Meta webhook does not duplicate transcript entries", async () => {
  const deps = tenantDeps();
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: TEST_CONFIG.META_PHONE_NUMBER_ID },
      messages: [{ id: "wamid.DUP", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const headers = { "x-hub-signature-256": signBody(rawBody) };

  await handleWebhookPost({ rawBody, headers }, deps).afterAck();
  await handleWebhookPost({ rawBody, headers }, deps).afterAck();

  const inbound = (await scopedToBusiness(deps.store, "default").listMessages(FROM))
    .filter((m) => m.direction === "inbound");
  assert.equal(inbound.length, 1, "the retry must not append a second copy");
});

test("a delivery status webhook updates the stored outbound message", async () => {
  const deps = tenantDeps();
  const scoped = scopedToBusiness(deps.store, "default");

  const msgPayload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: TEST_CONFIG.META_PHONE_NUMBER_ID },
      messages: [{ id: "wamid.S0", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  let raw = Buffer.from(JSON.stringify(msgPayload));
  await handleWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": signBody(raw) } }, deps).afterAck();

  const outbound = (await scoped.listMessages(FROM)).find((m) => m.direction === "outbound");
  assert.ok(outbound.messageId, "the outbound message recorded a provider id");

  const statusPayload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: TEST_CONFIG.META_PHONE_NUMBER_ID },
      statuses: [{ id: outbound.messageId, status: "delivered" }],
    } }] }],
  };
  raw = Buffer.from(JSON.stringify(statusPayload));
  await handleWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": signBody(raw) } }, deps).afterAck();

  const updated = (await scoped.listMessages(FROM)).find((m) => m.id === outbound.id);
  assert.equal(updated.deliveryStatus, "delivered");
});

test("transcripts are tenant isolated", async () => {
  const store = createStore(null);
  const acme = scopedToBusiness(store, "acme");
  const bolt = scopedToBusiness(store, "bolt");

  await acme.saveMessage({ id: "m1", conversationId: FROM, direction: "inbound", senderType: "customer", text: "acme secret", customerPhone: FROM });
  await bolt.saveMessage({ id: "m2", conversationId: FROM, direction: "inbound", senderType: "customer", text: "bolt secret", customerPhone: FROM });

  assert.deepEqual((await acme.listMessages(FROM)).map((m) => m.text), ["acme secret"]);
  assert.deepEqual((await bolt.listMessages(FROM)).map((m) => m.text), ["bolt secret"]);
});

test("a lead id from another tenant does not resolve on the detail page", async () => {
  const store = createStore(null);
  const deps = {
    store,
    businesses: createBusinessRegistry([
      { id: "acme", name: "Acme", ownerName: "A", ownerWhatsApp: "+911", phoneNumberId: "1", missedCallApiKey: "a" },
      { id: "bolt", name: "Bolt", ownerName: "B", ownerWhatsApp: "+912", phoneNumberId: "2", missedCallApiKey: "b" },
    ]),
    wa: createFakeWa(), templates,
    config: { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw") },
  };
  await scopedToBusiness(store, "bolt").saveLead({ id: "secret-lead", name: "Bolt customer", callerNumber: FROM, status: "new" });

  const session = await createSession(store, "acme");
  const res = await handleLeadDetail(
    { headers: { cookie: `${COOKIE_NAME}=${session}` }, query: new URLSearchParams({ id: "secret-lead" }) },
    deps
  );

  assert.equal(res.status, 404);
  assert.doesNotMatch(res.html, /Bolt customer/);
});

test("the detail page requires a session", async () => {
  const deps = tenantDeps();
  const res = await handleLeadDetail({ headers: {}, query: new URLSearchParams({ id: "anything" }) }, deps);
  assert.match(res.html, /type="password"/);
});

test("a legacy lead with no stored transcript still renders", () => {
  const html = leadDetailPage(
    { id: "old", callerNumber: FROM, name: "Balu", area: "Kukatpally", problem: "AC not cooling",
      urgency: "today", summary: "AC not cooling in Kukatpally.", status: "new",
      createdAt: new Date().toISOString() },
    []
  );
  assert.match(html, /Balu/);
  assert.match(html, /No transcript stored/);
  assert.doesNotMatch(html, /undefined/);
});

test("transcript text is escaped, not injected", () => {
  const html = leadDetailPage(
    { id: "x", callerNumber: FROM, name: "Balu", status: "new", createdAt: new Date().toISOString() },
    [{ id: "m", conversationId: FROM, direction: "inbound", senderType: "customer",
       messageType: "text", text: '<script>alert(1)</script>', timestamp: new Date().toISOString() }]
  );
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("non-text message types are labelled rather than rendered blank", () => {
  const html = leadDetailPage(
    { id: "x", callerNumber: FROM, name: "Balu", status: "new", createdAt: new Date().toISOString() },
    [{ id: "m", conversationId: FROM, direction: "inbound", senderType: "customer",
       messageType: "image", text: "", timestamp: new Date().toISOString() }]
  );
  assert.match(html, /\[image message\]/);
});

test("message type normalisation keeps to the known set", () => {
  assert.equal(normaliseMessageType("text"), "text");
  assert.equal(normaliseMessageType("image"), "image");
  assert.equal(normaliseMessageType("sticker"), "other");
  assert.equal(normaliseMessageType(undefined), "other");
});

test("providerMessageId pulls the wamid out of a send result", () => {
  assert.equal(providerMessageId({ ok: true, body: { messages: [{ id: "wamid.Z" }] } }), "wamid.Z");
  assert.equal(providerMessageId({ ok: false, body: null }), null);
});
