/**
 * Business configuration reaching the actual conversation.
 *
 * `services`, `areas`, `greeting` and `assistantName` were stored and
 * never read by the engine. These tests hold them to the only standard
 * that matters: the text the customer is actually sent.
 *
 * Most of them drive the REAL webhook route, so the context is routed by
 * phone_number_id exactly as in production rather than hand-passed in.
 * Assertions are on the stored outbound message text, not on markup.
 *
 * There is no LLM here and these tests do not pretend otherwise — the
 * replies are templates.json strings with business-specific lines
 * composed around them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/store.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { loadBusinessRegistry, businessRecord, businessContext } from "../lib/businesses.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { greetingLine, servicesLine, areasLine, compose } from "../lib/voice.mjs";
import { TEST_CONFIG, createFakeWa, signBody } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const CUSTOMER = "+919000000501";
const PHONE_A = "VOICE_PHONE_A";
const PHONE_B = "VOICE_PHONE_B";

const ALPHA = {
  id: "voice-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: "+911111111111",
  assistantName: "Asha", greeting: "", services: ["AC repair", "AC installation"], areas: ["Indiranagar", "HSR Layout"],
};
const BETA = {
  id: "voice-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: "+912222222222",
  assistantName: "Bina", greeting: "Namaste, Beta Plumbing here.", services: ["Leak repair"], areas: ["Koramangala"],
};

async function buildWorld() {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "9".repeat(64) };
  const integrations = createIntegrationService(store, config);

  for (const [biz, phone] of [[ALPHA, PHONE_A], [BETA, PHONE_B]]) {
    await store.saveBusiness(businessRecord({ ...biz, missedCallTemplate: "missed_call_immediate" }));
    await integrations.register({
      businessId: biz.id, phoneNumberId: phone, wabaId: `WABA_${biz.id}`, accessToken: `FAKE-${biz.id}`,
    });
  }

  const businesses = await loadBusinessRegistry(store, config);
  return {
    store, config, templates, businesses, integrations, wa: createFakeWa(),
    scopedA: scopedToBusiness(store, ALPHA.id), scopedB: scopedToBusiness(store, BETA.id),
  };
}

/** Replaces fetch so per-tenant sends succeed without touching Meta. */
function mockMeta() {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ messaging_product: "whatsapp", messages: [{ id: `wamid.V${++n}` }] }),
  });
  return { restore: () => { globalThis.fetch = original; } };
}

/** Delivers one customer message through the real, signed webhook. */
async function say(w, phoneNumberId, text, id = crypto.randomUUID()) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ id: "e", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ id, from: CUSTOMER.replace("+", ""), type: "text", text: { body: text }, timestamp: "1790000000" }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const meta = mockMeta();
  try {
    const res = handleWebhookPost(
      { method: "POST", headers: { "x-hub-signature-256": signBody(raw, w.config.META_APP_SECRET) }, rawBody: raw },
      w
    );
    if (res.afterAck) await res.afterAck();
  } finally {
    meta.restore();
  }
}

/** Everything the assistant said to the customer, in order. */
async function assistantSaid(scoped) {
  return (await scoped.listMessages(CUSTOMER))
    .filter((m) => m.direction === "outbound" && m.senderType === "assistant")
    .map((m) => m.text);
}

// ------------------------------------------------- the composition rules

test("voice lines are empty until a business configures them", () => {
  for (const ctx of [null, {}, { services: [], areas: [], greeting: "", assistantName: "" }]) {
    assert.equal(greetingLine(ctx), "");
    assert.equal(servicesLine(ctx), "");
    assert.equal(areasLine(ctx), "");
  }
  // Composing nothing around a template leaves the template untouched.
  assert.equal(compose("", "Sure. What area are you located in?", ""), "Sure. What area are you located in?");
});

test("a configured greeting wins; assistant name is the fallback", () => {
  assert.equal(greetingLine({ greeting: "Namaste, Beta here.", assistantName: "Bina", name: "Beta" }), "Namaste, Beta here.");
  assert.equal(greetingLine({ assistantName: "Asha", name: "Alpha Electrical" }), "This is Asha from Alpha Electrical.");
  assert.equal(greetingLine({ assistantName: "Asha" }), "This is Asha.");

  // A name alone does NOT introduce. Every business has one, so greeting
  // on that basis would change the opening line of every conversation
  // already running. Introducing is opt-in.
  assert.equal(greetingLine({ name: "Alpha Electrical" }), "");
  assert.equal(greetingLine({ name: "Planet Electrical", ownerName: "Mohamed" }), "");
});

test("lists read naturally and stay short", () => {
  assert.equal(servicesLine({ services: ["AC repair"] }), "We handle AC repair.");
  assert.equal(servicesLine({ services: ["AC repair", "Wiring"] }), "We handle AC repair and Wiring.");
  assert.equal(areasLine({ areas: ["A", "B", "C"] }), "We cover A, B and C.");
  // A long list is truncated rather than dumped — "and more" describes the
  // configured list, it does not claim extra capability.
  assert.equal(
    servicesLine({ services: ["a", "b", "c", "d", "e", "f"] }),
    "We handle a, b, c, d and more."
  );
  // Blank entries never become empty claims.
  assert.equal(servicesLine({ services: ["  ", ""] }), "");
});

// ----------------------------------------- runtime, through the webhook

test("a business's own services and areas reach the customer", async () => {
  const w = await buildWorld();
  await say(w, PHONE_A, "hello");

  const [first] = await assistantSaid(w.scopedA);
  assert.ok(first.includes("This is Asha from Alpha Electrical."), `greeting missing: ${first}`);
  assert.ok(first.includes("We handle AC repair and AC installation."), `services missing: ${first}`);
  // The underlying template is still there — this composes around it.
  assert.ok(first.includes(templates._conversation.ask_problem), "the original question was replaced");
});

test("the area question is asked plainly, without listing the areas covered", async () => {
  // "We cover X and Y" right before a customer names another area read as
  // turning them away; the owner decides from the lead.
  const w = await buildWorld();
  await say(w, PHONE_A, "my ac is not cooling");   // problem captured, area next

  const said = await assistantSaid(w.scopedA);
  const areaAsk = said.find((t) => t.includes(templates._conversation.ask_area));
  assert.ok(areaAsk, `no area question was asked: ${JSON.stringify(said)}`);
  assert.ok(!areaAsk.includes("We cover"), `areas were listed: ${areaAsk}`);
});

test("a configured greeting is used verbatim, and only once", async () => {
  const w = await buildWorld();
  await say(w, PHONE_B, "hi", "m1");
  await say(w, PHONE_B, "tap is leaking", "m2");
  await say(w, PHONE_B, "Koramangala", "m3");

  const said = await assistantSaid(w.scopedB);
  assert.ok(said.length >= 2, `expected several replies, got ${said.length}`);
  assert.ok(said[0].startsWith("Namaste, Beta Plumbing here."), `greeting not first: ${said[0]}`);

  const greetings = said.filter((t) => t.includes("Namaste, Beta Plumbing here."));
  assert.equal(greetings.length, 1, "the greeting was repeated");
});

// ------------------------------------------------- tenant isolation

test("one tenant's configuration never appears in another tenant's reply", async () => {
  const w = await buildWorld();
  await say(w, PHONE_A, "hello there", "a1");
  await say(w, PHONE_B, "hello there", "b1");
  await say(w, PHONE_A, "ac not cooling", "a2");
  await say(w, PHONE_B, "tap leaking", "b2");

  const saidA = (await assistantSaid(w.scopedA)).join("\n");
  const saidB = (await assistantSaid(w.scopedB)).join("\n");
  assert.ok(saidA.length && saidB.length);

  const betaMarkers = ["Beta Plumbing", "Bina", "Bharat", "Leak repair", "Koramangala", "Namaste"];
  const alphaMarkers = ["Alpha Electrical", "Asha", "Anita", "AC installation", "Indiranagar", "HSR Layout"];

  for (const marker of betaMarkers) {
    assert.ok(!saidA.includes(marker), `tenant B's "${marker}" reached tenant A's customer`);
  }
  for (const marker of alphaMarkers) {
    assert.ok(!saidB.includes(marker), `tenant A's "${marker}" reached tenant B's customer`);
  }

  // Each did receive its own.
  assert.ok(saidA.includes("Alpha Electrical") || saidA.includes("Asha"));
  assert.ok(saidB.includes("Beta Plumbing"));
});

test("the context handed to the engine is built from the routed business alone", async () => {
  const w = await buildWorld();
  const ctxA = businessContext(w.businesses.byId(ALPHA.id));
  const ctxB = businessContext(w.businesses.byId(BETA.id));

  assert.equal(ctxA.id, ALPHA.id);
  assert.deepEqual(ctxA.services, ALPHA.services);
  assert.deepEqual(ctxB.areas, BETA.areas);
  assert.ok(!JSON.stringify(ctxA).includes("Beta"));
  assert.ok(!JSON.stringify(ctxB).includes("Alpha"));

  // And it still carries no credentials.
  for (const key of ["accessToken", "passwordHash", "missedCallApiKey", "phoneNumberId", "wabaId"]) {
    assert.ok(!(key in ctxA), `businessContext exposed ${key}`);
  }
});

// -------------------------------------------- fallbacks and regression

test("a business that configures nothing sends exactly what it sent before", async () => {
  const store = createStore(null);
  const wa = createFakeWa();
  const deps = { store, wa, config: TEST_CONFIG, templates };

  // No `context` at all — the pre-existing call shape.
  await handleInboundMessage({ from: CUSTOMER, text: "hello" }, deps);
  const withoutContext = wa.sent.filter((s) => s.to === CUSTOMER).map((s) => s.body);

  const store2 = createStore(null);
  const wa2 = createFakeWa();
  // An empty context, as a business with a blank profile would produce.
  await handleInboundMessage({ from: CUSTOMER, text: "hello" },
    { store: store2, wa: wa2, config: TEST_CONFIG, templates, context: businessContext(businessRecord({ id: "blank" })) });
  const withBlankContext = wa2.sent.filter((s) => s.to === CUSTOMER).map((s) => s.body);

  assert.deepEqual(withBlankContext, withoutContext, "a blank profile changed the customer's message");
  assert.equal(withoutContext[0], templates._conversation.ask_problem);
});

test("emergency handling is unchanged and carries no greeting", async () => {
  const w = await buildWorld();
  await say(w, PHONE_A, "there is sparking from the socket and a burning smell");

  const said = await assistantSaid(w.scopedA);
  const safety = said.find((t) => t.includes("switch off at the mains"));
  assert.ok(safety, `the safety message was not sent: ${JSON.stringify(said)}`);
  assert.ok(safety.includes("Anita"), "the safety message did not name this business's owner");

  // Safety first: no introduction wrapped around it, and none added later
  // in a conversation that opened this way.
  assert.ok(!said.join("\n").includes("This is Asha"), "a greeting was attached to an emergency conversation");

  // The owner was alerted, on this tenant's own record.
  const ownerAlerts = (await w.scopedA.listMessages(CUSTOMER)).filter((m) => m.senderType === "owner");
  assert.ok(ownerAlerts.length >= 1, "no owner alert for the emergency");
  assert.equal(ownerAlerts[0].metadata.to, ALPHA.ownerWhatsApp);
});

test("one question at a time, and no invented customer details", async () => {
  const w = await buildWorld();
  await say(w, PHONE_A, "hello", "q1");

  const [first] = await assistantSaid(w.scopedA);
  // Exactly one question mark in the reply: the composed lines are
  // statements, only the template asks something.
  assert.equal((first.match(/\?/g) ?? []).length, 1, `more than one question asked: ${first}`);

  // Nothing about price, guarantees, availability or diagnosis.
  for (const forbidden of ["₹", "price", "cost", "guarantee", "warranty", "free of charge", "diagnos"]) {
    assert.ok(!first.toLowerCase().includes(forbidden), `the reply made a "${forbidden}" claim`);
  }

  // No customer field is invented before they give it.
  const lead = (await w.scopedA.listLeads())[0];
  assert.equal(lead, undefined, "a lead was created before the customer said anything");
});

test("the lead still completes, with this tenant's owner named in the confirmation", async () => {
  const w = await buildWorld();
  await say(w, PHONE_A, "ac not cooling", "c1");
  await say(w, PHONE_A, "Indiranagar", "c2");
  await say(w, PHONE_A, "Anil", "c3");
  await say(w, PHONE_A, "today", "c4");

  const leads = await w.scopedA.listLeads();
  assert.equal(leads.length, 1, `expected one lead, got ${leads.length}`);
  assert.equal(leads[0].name, "Anil");
  assert.equal(leads[0].businessId, ALPHA.id);

  const said = (await assistantSaid(w.scopedA)).join("\n");
  assert.ok(said.includes("Anita will be in touch shortly."), "the confirmation did not name this tenant's owner");
  assert.ok(!said.includes("Bharat"), "another tenant's owner was named");

  // Business B saw none of it.
  assert.deepEqual(await w.scopedB.listLeads(), []);
});
