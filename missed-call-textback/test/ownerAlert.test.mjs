import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { businessRecord, businessContext } from "../lib/businesses.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { ownerAlertParams, OWNER_ALERT_TEMPLATE } from "../lib/ownerAlert.mjs";
import { TEMPLATE_DEFINITIONS } from "../lib/embeddedSignup.mjs";
import { TEST_CONFIG, createFakeWa, signBody } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const CUSTOMER = "+919000000888";
const OWNER = "+919222222222";

function world({ ownerAlertApproved }) {
  const store = createStore(null);
  const wa = createFakeWa({ ownerAlertApproved });
  const business = businessRecord({ id: "biz", name: "City Electricals", industry: "Electrical", ownerName: "Ravi", ownerWhatsApp: OWNER });
  const config = { ...TEST_CONFIG, OWNER_NAME: "Ravi", MOHAMED_WHATSAPP_NUMBER: OWNER };
  const say = (text, id) =>
    handleInboundMessage({ from: CUSTOMER, text, messageId: id }, { store, wa, config, templates, context: businessContext(business) });
  return { store, wa, say };
}

async function completeLead(w) {
  await w.say("AC not cooling, Kukatpally", "m1");
  await w.say("Suresh", "m2");
  return w.say("today", "m3");
}

test("the lead-alert template is one Meta will accept", () => {
  const def = TEMPLATE_DEFINITIONS[OWNER_ALERT_TEMPLATE];
  assert.equal(def.category, "UTILITY");
  assert.doesNotMatch(def.body, /^\{\{|\}\}$/, "a template may not start or end with a variable");
  const vars = [...def.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(vars, Object.keys(def.example).sort(), "every variable has an example");

  // Meta rejects a template with too many variables for its length (subcode
  // 2388293); the first, short wording was refused in production for this.
  const fixedWords = def.body.replace(/\{\{\w+\}\}/g, " ").split(/\s+/).filter(Boolean).length;
  assert.ok(fixedWords / vars.length >= 8, `only ${fixedWords} fixed words for ${vars.length} variables`);
});

test("the template reference file says the same as the template Outly creates", () => {
  assert.equal(templates[OWNER_ALERT_TEMPLATE].body, TEMPLATE_DEFINITIONS[OWNER_ALERT_TEMPLATE].body);
});

test("an approved alert template is used, with clean non-empty values", async () => {
  const w = world({ ownerAlertApproved: true });
  const result = await completeLead(w);
  assert.ok(result.leadCompleted);
  assert.equal(result.ownerNotified, true);

  const alert = w.wa.sent.find((s) => s.to === OWNER);
  assert.equal(alert.kind, "template");
  assert.equal(alert.templateName, OWNER_ALERT_TEMPLATE);
  assert.deepEqual(alert.bodyParams, {
    business_name: "City Electricals",
    customer_name: "Suresh",
    customer_phone: CUSTOMER,
    lead_need: "AC not cooling (today)",
    lead_area: "Kukatpally",
  });
  for (const v of Object.values(alert.bodyParams)) assert.doesNotMatch(v, /\n|^\s*$/);
});

test("until the template is approved, the alert falls back to text", async () => {
  const w = world({ ownerAlertApproved: false });
  await completeLead(w);
  assert.equal(w.wa.rejected.length, 1, "the template was tried first");
  const alert = w.wa.sent.find((s) => s.to === OWNER);
  assert.equal(alert.kind, "text");
  assert.match(alert.body, /New Lead/);
});

test("empty fields become 'Not given', never an empty parameter Meta would reject", () => {
  const p = ownerAlertParams({ callerNumber: "+919000000001", problem: "", area: "", name: "", emergency: true }, "");
  assert.equal(p.customer_name, "Not given");
  assert.equal(p.lead_area, "Not given");
  assert.equal(p.business_name, "your business");
  assert.equal(p.lead_need, "URGENT: Service request");
});

function signed(payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } };
}

function webhookWorld() {
  const store = createStore(null);
  const wa = createFakeWa();
  const business = businessRecord({ id: "biz", name: "City Electricals", ownerName: "Ravi", ownerWhatsApp: OWNER });
  const deps = {
    config: TEST_CONFIG, store, wa, templates,
    businesses: { byPhoneNumberId: (id) => (id === "PNID" ? business : null), byId: () => business },
  };
  return { store, wa, deps, scoped: scopedToBusiness(store, "biz") };
}

test("a late 'failed' receipt for an owner alert marks the lead as not notified", async () => {
  const w = webhookWorld();
  await w.scoped.saveLead({ id: "lead1", name: "Suresh", ownerNotified: true });
  await w.scoped.saveMessage({
    id: "msg1", conversationId: CUSTOMER, leadId: "lead1", direction: "outbound", senderType: "owner",
    messageId: "wamid.ALERT1", text: "New Lead", metadata: {},
  });

  const res = handleWebhookPost(signed({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "PNID" },
      statuses: [{ id: "wamid.ALERT1", status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] }],
    } }] }],
  }), w.deps);
  await res.afterAck();

  assert.equal((await w.scoped.getLead("lead1")).ownerNotified, false);
});

test("the owner messaging their own business number is not treated as a customer", async () => {
  const w = webhookWorld();
  const res = handleWebhookPost(signed({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "PNID" },
      messages: [{ id: "wamid.OWNERHI", from: OWNER.slice(1), type: "text", text: { body: "hi" }, timestamp: "1700000000" }],
    } }] }],
  }), w.deps);
  await res.afterAck();

  assert.equal(await w.scoped.getConversation(OWNER), null, "no conversation started for the owner");
  assert.equal(w.wa.sent.length, 0);
});
