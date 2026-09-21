/**
 * Multi-tenant isolation.
 *
 * The bar here is that Business A cannot reach Business B's data through
 * ANY path — not the dashboard, not a status write, not an inbound
 * message, not a missed call. Isolation is structural (the business id is
 * part of every key), so these tests are really asserting that no route
 * forgets to scope.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { createBusinessRegistry, businessFromConfig, businessContext } from "../lib/businesses.mjs";
import { handleDashboard, handleLeadStatus } from "../routes/dashboard.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { hashPassword, COOKIE_NAME, createSession } from "../lib/auth.mjs";
import { createTestDeps, signBody, jsonCtx, createFakeWa, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const ACME = {
  id: "acme", name: "Acme Electrical", ownerName: "Anil", ownerWhatsApp: "+919000000111",
  phoneNumberId: "111111", missedCallApiKey: "acme-key",
  missedCallTemplate: "missed_call_immediate", templateLanguage: "en", status: "active",
};
const BOLT = {
  id: "bolt", name: "Bolt Services", ownerName: "Bhavna", ownerWhatsApp: "+919000000222",
  phoneNumberId: "222222", missedCallApiKey: "bolt-key",
  missedCallTemplate: "missed_call_immediate", templateLanguage: "en", status: "active",
};

function twoTenantDeps() {
  const store = createStore(null);
  const businesses = createBusinessRegistry([ACME, BOLT]);
  return {
    store, businesses, wa: createFakeWa(), templates,
    config: { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw") },
  };
}

test("leads written by one business are invisible to the other", async () => {
  const { store } = twoTenantDeps();
  const acme = scopedToBusiness(store, "acme");
  const bolt = scopedToBusiness(store, "bolt");

  await acme.saveLead({ id: "l1", name: "Acme customer", callerNumber: "+911", status: "new" });
  await bolt.saveLead({ id: "l2", name: "Bolt customer", callerNumber: "+912", status: "new" });

  const acmeLeads = await acme.listLeads();
  const boltLeads = await bolt.listLeads();

  assert.deepEqual(acmeLeads.map((l) => l.name), ["Acme customer"]);
  assert.deepEqual(boltLeads.map((l) => l.name), ["Bolt customer"]);
});

test("conversations are isolated even for the identical customer number", async () => {
  const { store } = twoTenantDeps();
  const acme = scopedToBusiness(store, "acme");
  const bolt = scopedToBusiness(store, "bolt");
  const shared = "+919505141818";

  await acme.saveConversation(shared, { fields: { problem: "AC not cooling" } });
  await bolt.saveConversation(shared, { fields: { problem: "wiring fault" } });

  assert.equal((await acme.getConversation(shared)).fields.problem, "AC not cooling");
  assert.equal((await bolt.getConversation(shared)).fields.problem, "wiring fault",
    "the same person contacting two businesses must not merge into one conversation");
});

test("message idempotency is per business, so one tenant cannot suppress another's message", async () => {
  const { store } = twoTenantDeps();
  const acme = scopedToBusiness(store, "acme");
  const bolt = scopedToBusiness(store, "bolt");

  await acme.markMessageProcessed("wamid.SHARED");
  assert.equal(await acme.hasProcessedMessage("wamid.SHARED"), true);
  assert.equal(await bolt.hasProcessedMessage("wamid.SHARED"), false,
    "a shared id must not let one tenant mark another's message as already handled");
});

test("the dashboard shows only the session's business", async () => {
  const deps = twoTenantDeps();
  await scopedToBusiness(deps.store, "acme").saveLead({ id: "l1", name: "Acme customer", callerNumber: "+911", status: "new" });
  await scopedToBusiness(deps.store, "bolt").saveLead({ id: "l2", name: "Bolt customer", callerNumber: "+912", status: "new" });

  const acmeSession = await createSession(deps.store, "acme");
  const res = await handleDashboard({ headers: { cookie: `${COOKIE_NAME}=${acmeSession}` }, query: new URLSearchParams() }, deps);

  assert.match(res.html, /Acme customer/);
  assert.doesNotMatch(res.html, /Bolt customer/, "another tenant's lead must never render");
});

test("a lead id from another business cannot be mutated", async () => {
  const deps = twoTenantDeps();
  await scopedToBusiness(deps.store, "bolt").saveLead({ id: "victim", name: "Bolt customer", callerNumber: "+912", status: "new" });

  const acmeSession = await createSession(deps.store, "acme");
  await handleLeadStatus({
    headers: { cookie: `${COOKIE_NAME}=${acmeSession}` },
    rawBody: Buffer.from(new URLSearchParams({ id: "victim", status: "lost" }).toString()),
  }, deps);

  const victim = await scopedToBusiness(deps.store, "bolt").getLead("victim");
  assert.equal(victim.status, "new", "a cross-tenant status write must not land");
});

test("an inbound message is routed by phone_number_id to the right business", async () => {
  const deps = twoTenantDeps();
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: BOLT.phoneNumberId },
      messages: [{ id: "wamid.T1", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } }, deps).afterAck();

  assert.ok(await scopedToBusiness(deps.store, "bolt").getConversation("+919505141818"),
    "the message must land in the business whose number it was sent to");
  assert.equal(await scopedToBusiness(deps.store, "acme").getConversation("+919505141818"), null,
    "and nowhere else");
});

test("an inbound message for an unknown number is dropped, not guessed at", async () => {
  const deps = twoTenantDeps();
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "999999" },
      messages: [{ id: "wamid.T2", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } }, deps).afterAck();

  assert.equal(deps.wa.sent.length, 0, "an unattributable event must not be processed under any tenant");
});

test("a missed-call API key only writes into its own business", async () => {
  const deps = twoTenantDeps();
  const res = await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: { authorization: "Bearer bolt-key" },
              body: { callerNumber: "+919505141818", timestamp: "2026-09-21T10:00:00Z" } }),
    deps
  );

  assert.equal(res.status, 200);
  assert.ok(await scopedToBusiness(deps.store, "bolt").lastMissedCallAt("+919505141818"));
  assert.equal(await scopedToBusiness(deps.store, "acme").lastMissedCallAt("+919505141818"), null);
});

test("an unrecognised API key is rejected outright", async () => {
  const deps = twoTenantDeps();
  const res = await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: { authorization: "Bearer not-a-real-key" },
              body: { callerNumber: "+919505141818", timestamp: "2026-09-21T10:00:00Z" } }),
    deps
  );
  assert.equal(res.status, 401);
  assert.equal(deps.wa.sent.length, 0);
});

test("outbound notifications go to the owning business's owner, not a global one", async () => {
  const deps = twoTenantDeps();
  await handleMissedCall(
    jsonCtx({ method: "POST", pathname: "/missed-call", headers: { authorization: "Bearer acme-key" },
              body: { callerNumber: "+919505141818", timestamp: "2026-09-21T10:00:00Z" } }),
    deps
  );
  const sent = deps.wa.sent.at(-1);
  assert.equal(sent.bodyParams.business_name, "Acme Electrical",
    "the template must carry the resolved tenant's name, not the env default");
});

test("businessContext exposes no secrets", () => {
  const ctx = businessContext(ACME);
  const serialised = JSON.stringify(ctx);
  assert.ok(!serialised.includes("acme-key"), "API keys must never reach the conversation layer");
  assert.equal(ctx.name, "Acme Electrical");
});

test("the env-configured business still resolves, so the live deployment is unchanged", () => {
  const business = businessFromConfig(TEST_CONFIG);
  const registry = createBusinessRegistry([business]);
  assert.equal(registry.byPhoneNumberId(TEST_CONFIG.META_PHONE_NUMBER_ID).id, "default");
  assert.equal(registry.byId("default").name, TEST_CONFIG.BUSINESS_NAME);
});

test("a single-business deployment still processes a message with an unexpected phone_number_id", async () => {
  // Guards the live test: strict matching on a one-tenant deployment would
  // turn any surprise in Meta's payload into a silently dropped customer.
  const store = createStore(null);
  const deps = {
    store,
    businesses: createBusinessRegistry([businessFromConfig(TEST_CONFIG)]),
    wa: createFakeWa(), templates, config: TEST_CONFIG,
  };
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "an-id-we-did-not-expect" },
      messages: [{ id: "wamid.SURPRISE", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } }, deps).afterAck();

  assert.ok(await scopedToBusiness(store, "default").getConversation("+919505141818"),
    "a lone business must still receive the message rather than drop it");
});

test("a single-business deployment processes a message with no metadata at all", async () => {
  const store = createStore(null);
  const deps = {
    store,
    businesses: createBusinessRegistry([businessFromConfig(TEST_CONFIG)]),
    wa: createFakeWa(), templates, config: TEST_CONFIG,
  };
  const payload = {
    entry: [{ changes: [{ value: {
      messages: [{ id: "wamid.NOMETA", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } }, deps).afterAck();

  assert.ok(await scopedToBusiness(store, "default").getConversation("+919505141818"));
});

test("with two businesses an unrecognised id is still a hard drop", async () => {
  const deps = twoTenantDeps();
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "999999" },
      messages: [{ id: "wamid.AMBIG", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody, headers: { "x-hub-signature-256": signBody(rawBody) } }, deps).afterAck();

  assert.equal(deps.wa.sent.length, 0, "ambiguous attribution must never be guessed");
});
