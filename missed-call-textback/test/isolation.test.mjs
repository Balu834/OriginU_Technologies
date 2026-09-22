/**
 * End-to-end multi-tenant isolation.
 *
 * Every assertion here is against a datastore record, an authorization
 * result, a status code, or a mocked Meta HTTP call — never against
 * rendered markup, with one deliberate exception: checks that a string
 * is ABSENT from a response. A leak check reads the whole response body
 * on purpose, and absence cannot produce the false green that a presence
 * check on incidental copy once did in this project.
 *
 * Fixtures only. The two tenants here hold invented credentials; no
 * production Meta token is loaded, and the network is mocked at `fetch`
 * so a mistake cannot reach Meta.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/store.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { createAccountService, resolveActor, can } from "../lib/users.mjs";
import { createIntegrationService, publicView } from "../lib/integrations.mjs";
import { loadBusinessRegistry, businessRecord, businessContext } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { createLead } from "../lib/leads.mjs";
import { createMessage } from "../lib/messages.mjs";
import {
  handleDashboard, handleLeadDetail, handleLeadStatus,
  handleLeadPriority, handleRetryNotification, handleLogin,
} from "../routes/dashboard.mjs";
import {
  handleWhatsappSettingsGet, handleWhatsappSettingsPost,
  handleTeamGet, handleTeamPost, handleOnboardingGet,
} from "../routes/accounts.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { TEST_CONFIG, createFakeWa, signBody } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

// ---------------------------------------------------------------- fixtures

const TEST_PHONE_A = "TEST_PHONE_A";
const TEST_PHONE_B = "TEST_PHONE_B";
const UNKNOWN_PHONE = "UNKNOWN_PHONE";

const TOKEN_A = "FAKE-ACCESS-TOKEN-ALPHA";
const TOKEN_B = "FAKE-ACCESS-TOKEN-BETA";
const APP_SECRET_A = "FAKE-APP-SECRET-ALPHA";
const APP_SECRET_B = "FAKE-APP-SECRET-BETA";
const VERIFY_A = "FAKE-VERIFY-TOKEN-ALPHA";
const VERIFY_B = "FAKE-VERIFY-TOKEN-BETA";

const PASSWORD_A = "alpha-password-1";
const PASSWORD_B = "beta-password-11";
const DEFAULT_PASSWORD = "default-tenant-password";

/** Both tenants are messaged from the same handset on purpose — a shared customer number is where a namespacing mistake would show. */
const CUSTOMER = "+919000000001";

const ALL_SECRETS = [TOKEN_A, TOKEN_B, APP_SECRET_A, APP_SECRET_B, VERIFY_A, VERIFY_B,
  PASSWORD_A, PASSWORD_B, DEFAULT_PASSWORD, TEST_CONFIG.META_ACCESS_TOKEN, TEST_CONFIG.META_APP_SECRET];

async function buildWorld() {
  const store = createStore(null);
  const config = {
    ...TEST_CONFIG,
    INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
    DASHBOARD_PASSWORD_HASH: hashPassword(DEFAULT_PASSWORD),
  };

  const accounts = createAccountService(store);
  const integrations = createIntegrationService(store, config);

  const userA = await accounts.signUp({ email: "owner-a@example.test", password: PASSWORD_A });
  const userB = await accounts.signUp({ email: "owner-b@example.test", password: PASSWORD_B });

  const bizA = businessRecord({
    id: "biz-alpha", name: "Alpha Electrical", ownerName: "Anita",
    ownerWhatsApp: "+911111111111", services: ["Electrical repair"], areas: ["Indiranagar"],
    phoneNumberId: TEST_PHONE_A, missedCallTemplate: "missed_call_immediate",
  });
  const bizB = businessRecord({
    id: "biz-beta", name: "Beta Plumbing", ownerName: "Bharat",
    ownerWhatsApp: "+912222222222", services: ["Plumbing"], areas: ["Koramangala"],
    phoneNumberId: TEST_PHONE_B, missedCallTemplate: "missed_call_immediate",
  });

  await accounts.createBusinessFor(userA, bizA);
  await accounts.createBusinessFor(userB, bizB);

  await integrations.register({
    businessId: bizA.id, phoneNumberId: TEST_PHONE_A,
    accessToken: TOKEN_A, appSecret: APP_SECRET_A, verifyToken: VERIFY_A,
  });
  await integrations.register({
    businessId: bizB.id, phoneNumberId: TEST_PHONE_B,
    accessToken: TOKEN_B, appSecret: APP_SECRET_B, verifyToken: VERIFY_B,
  });

  const businesses = await loadBusinessRegistry(store, config);
  const wa = createFakeWa();

  const deps = { store, config, wa, templates, businesses, integrations, accounts };
  return { ...deps, userA, userB, bizA, bizB, scopedA: scopedToBusiness(store, bizA.id), scopedB: scopedToBusiness(store, bizB.id) };
}

async function sessionFor(world, user) {
  const memberships = await world.accounts.membershipsOf(user.id);
  return createSession(world.store, memberships[0]?.businessId ?? null, { userId: user.id });
}

function ctx({ method = "GET", pathname = "/", query = {}, session = null, form = null, headers = {} }) {
  return {
    method, pathname,
    query: new URLSearchParams(query),
    headers: { ...(session ? { cookie: `${COOKIE_NAME}=${session}` } : {}), ...headers },
    rawBody: Buffer.from(form ? new URLSearchParams(form).toString() : ""),
  };
}

/** Everything a route result could put in front of a browser, as one string. */
function renderedBody(result) {
  return [result?.html, result?.rawText, result?.body ? JSON.stringify(result.body) : "",
    JSON.stringify(result?.headers ?? {})].filter(Boolean).join("\n");
}

function webhookPayload({ phoneNumberId, from = CUSTOMER, text, messageId = crypto.randomUUID(), statuses }) {
  const value = { metadata: { phone_number_id: phoneNumberId, display_phone_number: "000" } };
  if (statuses) value.statuses = statuses;
  if (text !== undefined) {
    value.messages = [{
      id: messageId, from: from.replace("+", ""), type: "text",
      text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)),
    }];
  }
  return { object: "whatsapp_business_account", entry: [{ id: "entry", changes: [{ field: "messages", value }] }] };
}

/** Delivers one payload through the real webhook route, signed as Meta signs it (app-level secret). */
async function deliver(world, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const result = handleWebhookPost(
    { method: "POST", pathname: "/webhook", query: new URLSearchParams(),
      headers: { "x-hub-signature-256": signBody(raw, world.config.META_APP_SECRET) }, rawBody: raw },
    world
  );
  if (result.afterAck) await result.afterAck();
  return result;
}

/** Replaces global fetch with a recorder, so "which credentials went to Meta" is observable. */
function mockMetaApi() {
  const calls = [];
  const original = globalThis.fetch;
  let counter = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      authorization: options.headers?.Authorization ?? "",
      body: JSON.parse(options.body ?? "{}"),
    });
    return {
      ok: true, status: 200,
      json: async () => ({ messaging_product: "whatsapp", messages: [{ id: `wamid.MOCK${++counter}` }] }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Captures structured log output so it can be searched for secrets. */
function captureLogs() {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

// ============================================================ 2. AUTH

test("each owner's session resolves to their own business and role", async () => {
  const w = await buildWorld();

  const loginA = await handleLogin(ctx({ method: "POST", form: { email: "owner-a@example.test", password: PASSWORD_A } }), w);
  const loginB = await handleLogin(ctx({ method: "POST", form: { email: "owner-b@example.test", password: PASSWORD_B } }), w);
  assert.equal(loginA.status, 302);
  assert.equal(loginB.status, 302);

  const idA = /mct_session=([a-f0-9]+)/.exec(loginA.headers["Set-Cookie"])[1];
  const idB = /mct_session=([a-f0-9]+)/.exec(loginB.headers["Set-Cookie"])[1];

  const actorA = await resolveActor(await w.store.getSession(idA), w.accounts);
  const actorB = await resolveActor(await w.store.getSession(idB), w.accounts);

  assert.equal(actorA.businessId, w.bizA.id);
  assert.equal(actorA.role, "OWNER");
  assert.equal(actorB.businessId, w.bizB.id);
  assert.equal(actorB.role, "OWNER");
  assert.notEqual(actorA.user.id, actorB.user.id);
});

test("a user's password does not authenticate as the other tenant", async () => {
  const w = await buildWorld();
  assert.equal(await w.accounts.authenticate({ email: "owner-a@example.test", password: PASSWORD_B }), null);
  // The legacy per-business password path must not accept a user account password either.
  assert.equal(w.businesses.byPassword(PASSWORD_A, (p, h) => hashPassword(p, h.split(":")[0]) === h), null);
});

test("userId, businessId and role in the request body are ignored, not honoured", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.userA);

  // Every client-supplied authority field at once, aimed at tenant B.
  const result = await handleWhatsappSettingsPost(ctx({
    method: "POST", session: sessionA,
    form: {
      businessId: w.bizB.id, userId: w.userB.id, role: "OWNER",
      phoneNumberId: "TEST_PHONE_A_ROTATED", accessToken: "FAKE-ROTATED-A",
    },
  }), w);
  assert.equal(result.status, 302);

  // B's integration is byte-identical to before; A's is the one that moved.
  const intB = await w.integrations.forBusiness(w.bizB.id);
  assert.equal(intB.phoneNumberId, TEST_PHONE_B);
  assert.equal(w.integrations.secretsOf(intB).accessToken, TOKEN_B);

  const intA = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(intA.businessId, w.bizA.id);
  assert.equal(intA.phoneNumberId, "TEST_PHONE_A_ROTATED");
});

test("a forged session id resolves to no actor at all", async () => {
  const w = await buildWorld();
  const forged = crypto.randomBytes(32).toString("hex");
  assert.equal(await w.store.getSession(forged), null);
  assert.equal(await resolveActor(await w.store.getSession(forged), w.accounts), null);

  const result = await handleWhatsappSettingsGet(ctx({ session: forged }), w);
  assert.equal(result.status, 302);
  assert.equal(result.headers.Location, "/login");
});

test("a session whose membership was revoked stops resolving to that business", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  const [membership] = await w.accounts.membershipsOf(w.userA.id);

  await w.store.deleteMembership(membership.id);

  assert.equal(await resolveActor(await w.store.getSession(session), w.accounts), null);
  const settings = await handleWhatsappSettingsGet(ctx({ session }), w);
  assert.equal(settings.headers?.Location, "/login");

  // The dashboard must reach the same conclusion as the settings page.
  const dashboard = await handleDashboard(ctx({ pathname: "/leads", session }), w);
  assert.ok(
    !renderedBody(dashboard).includes(w.bizA.id),
    "a revoked membership still rendered the business's dashboard"
  );
});

test("a signed-up user with no business of their own sees no tenant's data", async () => {
  const w = await buildWorld();
  const { leadA } = await seedLeads(w);

  // Signed up, never onboarded: the session names no business at all. This
  // used to fall through to the `default` tenant and hand a stranger the
  // live business's leads.
  const stranger = await w.accounts.signUp({ email: "stranger@example.test", password: "stranger-password" });
  const session = await createSession(w.store, null, { userId: stranger.id });

  const defaultLead = createLead({ callerNumber: "+919505141818", fields: { name: "Default Tenant Customer", area: "HSR", problem: "fan", urgency: "today" } });
  await scopedToBusiness(w.store, "default").saveLead(defaultLead);

  const dashboard = await handleDashboard(ctx({ pathname: "/leads", session }), w);
  const body = renderedBody(dashboard);
  assert.ok(!body.includes(defaultLead.id), "a stranger's dashboard showed the default tenant's lead");
  assert.ok(!body.includes("Default Tenant Customer"), "a stranger's dashboard showed the default tenant's customer");
  assert.ok(!body.includes(leadA.id), "a stranger's dashboard showed another tenant's lead");

  // Direct lead ids are equally unreachable.
  for (const id of [defaultLead.id, leadA.id]) {
    const detail = await handleLeadDetail(ctx({ pathname: "/lead", session, query: { id } }), w);
    assert.ok(detail.status !== 200, `a stranger read lead ${id} directly`);
    assert.ok(!renderedBody(detail).includes(id));
  }

  // And a write attempt changes nothing.
  await handleLeadStatus(ctx({ method: "POST", session, form: { id: defaultLead.id, status: "contacted" } }), w);
  assert.equal((await scopedToBusiness(w.store, "default").getLead(defaultLead.id)).status, "new");
});

// =================================================== 3. LEAD ISOLATION

async function seedLeads(w) {
  const leadA = createLead({ callerNumber: CUSTOMER, fields: { name: "A Test Lead", area: "Indiranagar", problem: "fan not working", urgency: "today" }, emergency: false });
  const leadB = createLead({ callerNumber: CUSTOMER, fields: { name: "B Test Lead", area: "Koramangala", problem: "tap leaking", urgency: "today" }, emergency: false });
  await w.scopedA.saveLead(leadA);
  await w.scopedB.saveLead(leadB);
  return { leadA, leadB };
}

test("each tenant's lead list contains only its own leads", async () => {
  const w = await buildWorld();
  const { leadA, leadB } = await seedLeads(w);

  const listA = await w.scopedA.listLeads();
  const listB = await w.scopedB.listLeads();

  assert.deepEqual(listA.map((l) => l.id), [leadA.id]);
  assert.deepEqual(listB.map((l) => l.id), [leadB.id]);
  assert.equal(listA[0].businessId, w.bizA.id);
  assert.equal(listB[0].businessId, w.bizB.id);

  // The default tenant, which predates both, sees neither.
  const listDefault = await scopedToBusiness(w.store, "default").listLeads();
  assert.deepEqual(listDefault, []);
});

test("the dashboard, its search and its filters never render the other tenant's lead", async () => {
  const w = await buildWorld();
  const { leadB } = await seedLeads(w);
  const sessionA = await sessionFor(w, w.userA);

  const queries = [
    {},
    { q: "B Test Lead" },
    { q: "tap leaking" },
    { status: "new" },
    { urgency: "URGENT" },
    { q: "Koramangala", status: "new", urgency: "NORMAL" },
  ];

  for (const query of queries) {
    const body = renderedBody(await handleDashboard(ctx({ pathname: "/leads", session: sessionA, query }), w));
    const label = JSON.stringify(query);

    // The lead id is the assertion that means something. B's name and
    // problem text are echoed back by the filter form itself when they are
    // the search term, so looking for those would fail on the search box
    // rather than on a leak — the same mistake that produced a false green
    // in this project once already.
    assert.ok(!body.includes(leadB.id), `tenant B's lead id leaked into ${label}`);

    // The customer number is deliberately the same for both tenants, so it
    // is not a discriminator here — the lead id is. Tenant B's business
    // identity, which the search box never echoes, is.
    assert.ok(!body.includes("Beta Plumbing"), `tenant B's business name leaked into ${label}`);
    assert.ok(!body.includes(w.bizB.id), `tenant B's business id leaked into ${label}`);
  }

  // A search matching nothing of A's returns nothing of B's, proven by the
  // stored data the route reads rather than by the markup it produces.
  const matches = (await w.scopedA.listLeads()).filter((l) => l.problem.includes("tap leaking"));
  assert.deepEqual(matches, []);
});

test("a lead id from the other tenant does not resolve on the detail page", async () => {
  const w = await buildWorld();
  const { leadA, leadB } = await seedLeads(w);
  const sessionA = await sessionFor(w, w.userA);
  const sessionB = await sessionFor(w, w.userB);

  assert.equal((await handleLeadDetail(ctx({ pathname: "/lead", session: sessionA, query: { id: leadA.id } }), w)).status, 200);
  assert.equal((await handleLeadDetail(ctx({ pathname: "/lead", session: sessionA, query: { id: leadB.id } }), w)).status, 404);
  assert.equal((await handleLeadDetail(ctx({ pathname: "/lead", session: sessionB, query: { id: leadB.id } }), w)).status, 200);
  assert.equal((await handleLeadDetail(ctx({ pathname: "/lead", session: sessionB, query: { id: leadA.id } }), w)).status, 404);
});

test("status, priority and notification retry cannot touch the other tenant's lead", async () => {
  const w = await buildWorld();
  const { leadB } = await seedLeads(w);
  const sessionA = await sessionFor(w, w.userA);

  await handleLeadStatus(ctx({ method: "POST", session: sessionA, form: { id: leadB.id, status: "contacted" } }), w);
  await handleLeadPriority(ctx({ method: "POST", session: sessionA, form: { id: leadB.id, priority: "URGENT" } }), w);
  await handleRetryNotification(ctx({ method: "POST", session: sessionA, form: { id: leadB.id } }), w);

  const after = await w.scopedB.getLead(leadB.id);
  assert.equal(after.status, "new", "tenant A moved tenant B's lead status");
  assert.equal(after.priority, "NORMAL", "tenant A changed tenant B's lead priority");
  assert.equal(after.ownerNotified, undefined, "tenant A triggered a notification on tenant B's lead");
  assert.equal(after.updatedAt, leadB.updatedAt, "tenant B's lead was written to at all");

  // And nothing was sent on B's behalf.
  assert.equal(w.wa.sent.length, 0);
});

// =========================================== 4. CONVERSATION ISOLATION

async function seedConversations(w) {
  const now = new Date().toISOString();
  await w.scopedA.saveConversation(CUSTOMER, { callerNumber: CUSTOMER, note: "Business A private message", fields: {}, createdAt: now, updatedAt: now });
  await w.scopedB.saveConversation(CUSTOMER, { callerNumber: CUSTOMER, note: "Business B private message", fields: {}, createdAt: now, updatedAt: now });

  const msgA = createMessage({ conversationId: CUSTOMER, direction: "inbound", senderType: "customer", customerPhone: CUSTOMER, messageId: "wamid.A1", text: "Business A private message" });
  const msgB = createMessage({ conversationId: CUSTOMER, direction: "inbound", senderType: "customer", customerPhone: CUSTOMER, messageId: "wamid.B1", text: "Business B private message" });
  await w.scopedA.saveMessage(msgA);
  await w.scopedB.saveMessage(msgB);
  return { msgA, msgB };
}

test("the same customer number holds a separate conversation per tenant", async () => {
  const w = await buildWorld();
  await seedConversations(w);

  assert.equal((await w.scopedA.getConversation(CUSTOMER)).note, "Business A private message");
  assert.equal((await w.scopedB.getConversation(CUSTOMER)).note, "Business B private message");
  // The unscoped key is empty — nothing was ever written outside a tenant.
  assert.equal(await w.store.getConversation(CUSTOMER), null);
});

test("transcripts do not cross tenants by conversation id, message id or provider id", async () => {
  const w = await buildWorld();
  const { msgA, msgB } = await seedConversations(w);

  const textsA = (await w.scopedA.listMessages(CUSTOMER)).map((m) => m.text);
  const textsB = (await w.scopedB.listMessages(CUSTOMER)).map((m) => m.text);
  assert.deepEqual(textsA, ["Business A private message"]);
  assert.deepEqual(textsB, ["Business B private message"]);

  // Provider (wamid) lookup is namespaced: B's wamid is invisible to A.
  assert.equal(await w.scopedA.findMessageByProviderId("wamid.B1"), null);
  assert.equal(await w.scopedB.findMessageByProviderId("wamid.A1"), null);
  assert.equal((await w.scopedA.findMessageByProviderId("wamid.A1")).id, msgA.id);
  assert.equal((await w.scopedB.findMessageByProviderId("wamid.B1")).id, msgB.id);

  // Our own message id, as stored, is equally unreachable across the boundary.
  assert.equal(await w.scopedA.getLead(msgB.id), null);
});

test("a lead detail page never renders the other tenant's transcript", async () => {
  const w = await buildWorld();
  await seedConversations(w);
  const { leadA } = await seedLeads(w);
  const sessionA = await sessionFor(w, w.userA);

  const body = renderedBody(await handleLeadDetail(ctx({ pathname: "/lead", session: sessionA, query: { id: leadA.id } }), w));
  assert.ok(body.includes("Business A private message"), "tenant A's own transcript failed to render");
  assert.ok(!body.includes("Business B private message"), "tenant B's message leaked into tenant A's transcript");
});

// ============================================= 5. WHATSAPP ROUTING

test("inbound messages route to the business that owns the phone_number_id", async () => {
  const w = await buildWorld();
  const meta = mockMetaApi();
  try {
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_A, text: "AC not cooling", messageId: "wamid.IN-A" }));
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_B, text: "Need electrician", messageId: "wamid.IN-B" }));
  } finally {
    meta.restore();
  }

  const convA = await w.scopedA.getConversation(CUSTOMER);
  const convB = await w.scopedB.getConversation(CUSTOMER);
  assert.ok(convA, "payload for TEST_PHONE_A created no conversation for business A");
  assert.ok(convB, "payload for TEST_PHONE_B created no conversation for business B");

  const textsA = (await w.scopedA.listMessages(CUSTOMER)).filter((m) => m.direction === "inbound").map((m) => m.text);
  const textsB = (await w.scopedB.listMessages(CUSTOMER)).filter((m) => m.direction === "inbound").map((m) => m.text);
  assert.deepEqual(textsA, ["AC not cooling"]);
  assert.deepEqual(textsB, ["Need electrician"]);

  // Cross-check the idempotency namespace too: A's message id is not marked
  // processed for B, so a genuine B message with the same id is not swallowed.
  assert.equal(await w.scopedA.hasProcessedMessage("wamid.IN-A"), true);
  assert.equal(await w.scopedB.hasProcessedMessage("wamid.IN-A"), false);
});

test("an unknown phone_number_id creates nothing and never falls back to default", async () => {
  const w = await buildWorld();
  const meta = mockMetaApi();
  let result;
  try {
    result = await deliver(w, webhookPayload({ phoneNumberId: UNKNOWN_PHONE, text: "hello?", messageId: "wamid.IN-UNKNOWN" }));
  } finally {
    meta.restore();
  }

  // Meta still gets its 200 — retrying an unattributable event forever helps no one.
  assert.equal(result.status, 200);

  for (const id of ["default", w.bizA.id, w.bizB.id]) {
    const scoped = scopedToBusiness(w.store, id);
    assert.equal(await scoped.getConversation(CUSTOMER), null, `unknown number created a conversation under ${id}`);
    assert.deepEqual(await scoped.listLeads(), [], `unknown number created a lead under ${id}`);
    assert.deepEqual(await scoped.listMessages(CUSTOMER), [], `unknown number stored a message under ${id}`);
  }
  assert.equal(await w.store.getConversation(CUSTOMER), null);
  assert.equal(meta.calls.length, 0, "an unattributable event still sent a WhatsApp message");
});

test("a missing metadata block is dropped rather than guessed at", async () => {
  const w = await buildWorld();
  const payload = webhookPayload({ phoneNumberId: TEST_PHONE_A, text: "hi", messageId: "wamid.NOMETA" });
  delete payload.entry[0].changes[0].value.metadata;

  const meta = mockMetaApi();
  try {
    await deliver(w, payload);
  } finally {
    meta.restore();
  }

  assert.equal(await w.scopedA.getConversation(CUSTOMER), null);
  assert.equal(await w.scopedB.getConversation(CUSTOMER), null);
  assert.equal(meta.calls.length, 0);
});

// ============================================== 6. OUTBOUND ROUTING

test("each tenant's replies go out on its own credentials, never the other's", async () => {
  const w = await buildWorld();
  const meta = mockMetaApi();
  let callsA, callsB;
  try {
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_A, text: "AC not cooling", messageId: "wamid.OUT-A" }));
    callsA = meta.calls.splice(0);
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_B, text: "Need electrician", messageId: "wamid.OUT-B" }));
    callsB = meta.calls.splice(0);
  } finally {
    meta.restore();
  }

  assert.ok(callsA.length > 0, "business A's inbound message produced no outbound call");
  assert.ok(callsB.length > 0, "business B's inbound message produced no outbound call");

  for (const call of callsA) {
    assert.ok(call.url.includes(TEST_PHONE_A), `business A sent via ${call.url}`);
    assert.equal(call.authorization, `Bearer ${TOKEN_A}`);
    assert.ok(!call.url.includes(TEST_PHONE_B));
    assert.ok(!call.authorization.includes(TOKEN_B), "business A sent using business B's token");
    assert.ok(!call.authorization.includes(TEST_CONFIG.META_ACCESS_TOKEN), "business A fell back to the global token");
  }
  for (const call of callsB) {
    assert.ok(call.url.includes(TEST_PHONE_B), `business B sent via ${call.url}`);
    assert.equal(call.authorization, `Bearer ${TOKEN_B}`);
    assert.ok(!call.authorization.includes(TOKEN_A), "business B sent using business A's token");
  }
});

test("owner notification retry sends on the tenant's own credentials", async () => {
  const w = await buildWorld();
  const { leadA } = await seedLeads(w);
  const sessionA = await sessionFor(w, w.userA);

  const meta = mockMetaApi();
  try {
    await handleRetryNotification(ctx({ method: "POST", session: sessionA, form: { id: leadA.id } }), w);
  } finally {
    meta.restore();
  }

  assert.ok(meta.calls.length > 0, "retry sent nothing at all");
  for (const call of meta.calls) {
    assert.ok(call.url.includes(TEST_PHONE_A), `retry for business A sent via ${call.url}`);
    assert.equal(call.authorization, `Bearer ${TOKEN_A}`);
    assert.equal(call.body.to, w.bizA.ownerWhatsApp, "retry notified the wrong owner");
  }
});

test("a missed call for one tenant is sent on that tenant's number, not the shared one", async () => {
  const w = await buildWorld();
  const withKey = businessRecord({
    ...w.bizA, missedCallApiKey: "alpha-missed-call-key", templateLanguage: "en",
  });
  await w.store.saveBusiness(withKey);
  const businesses = await loadBusinessRegistry(w.store, w.config);
  const deps = { ...w, businesses };

  const meta = mockMetaApi();
  let result;
  try {
    result = await handleMissedCall({
      method: "POST", pathname: "/missed-call", query: new URLSearchParams(),
      headers: { authorization: "Bearer alpha-missed-call-key" },
      rawBody: Buffer.alloc(0),
      json: { callerNumber: CUSTOMER, timestamp: new Date().toISOString() },
    }, deps);
  } finally {
    meta.restore();
  }

  assert.equal(result.status, 200);
  assert.ok(meta.calls.length > 0, "the missed-call template was never sent");
  for (const call of meta.calls) {
    assert.ok(call.url.includes(TEST_PHONE_A), `business A's template went out via ${call.url}`);
    assert.equal(call.authorization, `Bearer ${TOKEN_A}`);
    assert.ok(!call.authorization.includes(TEST_CONFIG.META_ACCESS_TOKEN), "the template used the global token");
    // The template's own body must name this business, not the deployment's.
    const params = call.body.template.components[0].parameters;
    assert.equal(params.find((p) => p.parameter_name === "business_name").text, "Alpha Electrical");
    assert.equal(params.find((p) => p.parameter_name === "owner_name").text, "Anita");
  }
});

test("a business with no integration is refused rather than lent the shared client", async () => {
  const w = await buildWorld();
  const orphan = businessRecord({
    id: "biz-orphan", name: "Orphan Services", ownerName: "Omar", ownerWhatsApp: "+913333333333",
    missedCallApiKey: "orphan-missed-call-key", missedCallTemplate: "missed_call_immediate", templateLanguage: "en",
  });
  await w.store.saveBusiness(orphan);
  const businesses = await loadBusinessRegistry(w.store, w.config);

  const meta = mockMetaApi();
  let result;
  try {
    result = await handleMissedCall({
      method: "POST", pathname: "/missed-call", query: new URLSearchParams(),
      headers: { authorization: "Bearer orphan-missed-call-key" },
      rawBody: Buffer.alloc(0),
      json: { callerNumber: CUSTOMER, timestamp: new Date().toISOString() },
    }, { ...w, businesses });
  } finally {
    meta.restore();
  }

  assert.equal(result.status, 503);
  assert.equal(result.body.sent, false);
  assert.equal(meta.calls.length, 0, "a business with no integration still sent a WhatsApp message");
  assert.equal(w.wa.sent.length, 0, "a business with no integration borrowed the shared client");
});

// ==================================== 7. STATUS WEBHOOK ISOLATION

test("a delivery status only updates a message in its own tenant", async () => {
  const w = await buildWorld();
  const { msgA, msgB } = await seedConversations(w);

  const meta = mockMetaApi();
  try {
    // Business A's number reporting business B's wamid — the cross-tenant attempt.
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_A, statuses: [{ id: "wamid.B1", status: "delivered", recipient_id: "919000000001" }] }));
    const bUntouched = await w.scopedB.findMessageByProviderId("wamid.B1");
    assert.equal(bUntouched.deliveryStatus, null, "tenant A's webhook updated tenant B's message");
    assert.equal(bUntouched.metadata.statusAt, undefined);

    // The legitimate case still works, so the test above isn't passing by inertia.
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_A, statuses: [{ id: "wamid.A1", status: "delivered", recipient_id: "919000000001" }] }));
    assert.equal((await w.scopedA.findMessageByProviderId("wamid.A1")).deliveryStatus, "delivered");

    // And B's own webhook reaches only B.
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_B, statuses: [{ id: "wamid.B1", status: "read", recipient_id: "919000000001" }] }));
    assert.equal((await w.scopedB.findMessageByProviderId("wamid.B1")).deliveryStatus, "read");
    assert.equal((await w.scopedA.findMessageByProviderId("wamid.A1")).deliveryStatus, "delivered");
  } finally {
    meta.restore();
  }
  assert.ok(msgA.id !== msgB.id);
});

// ========================================== 8. BUSINESS CONTEXT ISOLATION

test("a tenant's conversation context carries none of the other tenant's identity", async () => {
  const w = await buildWorld();
  const meta = mockMetaApi();
  try {
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_A, text: "AC not cooling in Indiranagar, I am Anil, need someone today", messageId: "wamid.CTX-A" }));
    await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_B, text: "tap leaking in Koramangala, I am Bina, need someone today", messageId: "wamid.CTX-B" }));
  } finally {
    meta.restore();
  }

  const outboundA = (await w.scopedA.listMessages(CUSTOMER)).filter((m) => m.direction === "outbound");
  const outboundB = (await w.scopedB.listMessages(CUSTOMER)).filter((m) => m.direction === "outbound");
  assert.ok(outboundA.length > 0 && outboundB.length > 0, "one of the tenants produced no outbound message");

  const forbiddenInA = [w.bizB.name, w.bizB.ownerName, w.bizB.ownerWhatsApp, "Plumbing", "Koramangala", "Bina"];
  const forbiddenInB = [w.bizA.name, w.bizA.ownerName, w.bizA.ownerWhatsApp, "Electrical repair", "Indiranagar", "Anil"];

  for (const m of outboundA) {
    for (const bad of forbiddenInA) assert.ok(!m.text.includes(bad), `business A's outbound text contained "${bad}"`);
  }
  for (const m of outboundB) {
    for (const bad of forbiddenInB) assert.ok(!m.text.includes(bad), `business B's outbound text contained "${bad}"`);
  }

  // The owner alert is the message that actually carries tenant identity: it
  // must reach that tenant's owner and no one else's.
  const ownerMsgsA = outboundA.filter((m) => m.senderType === "owner");
  const ownerMsgsB = outboundB.filter((m) => m.senderType === "owner");
  assert.ok(ownerMsgsA.length > 0 && ownerMsgsB.length > 0);
  for (const m of ownerMsgsA) assert.equal(m.metadata.to, w.bizA.ownerWhatsApp);
  for (const m of ownerMsgsB) assert.equal(m.metadata.to, w.bizB.ownerWhatsApp);
});

test("businessContext is built from one business and exposes no credentials", async () => {
  const w = await buildWorld();
  const ctxA = businessContext(w.bizA);
  const ctxB = businessContext(w.bizB);

  assert.equal(ctxA.name, "Alpha Electrical");
  assert.deepEqual(ctxA.services, ["Electrical repair"]);
  assert.ok(!JSON.stringify(ctxA).includes("Beta Plumbing"));
  assert.ok(!JSON.stringify(ctxB).includes("Alpha Electrical"));

  for (const serialised of [JSON.stringify(ctxA), JSON.stringify(ctxB)]) {
    for (const secret of ALL_SECRETS) assert.ok(!serialised.includes(secret));
    for (const field of ["passwordHash", "accessToken", "appSecret", "verifyToken", "missedCallApiKey", "phoneNumberId"]) {
      assert.ok(!serialised.includes(field), `businessContext exposed ${field}`);
    }
  }

  // Safety rules are the product's, and a tenant cannot switch them off.
  assert.equal(ctxA.safety.neverDiagnose, true);
  assert.throws(() => { ctxA.safety.neverDiagnose = false; });
});

// ============================================== 9. SETTINGS ISOLATION

test("one tenant's settings change leaves the other tenant untouched", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.userA);
  const beforeB = await w.integrations.forBusiness(w.bizB.id);

  const res = await handleWhatsappSettingsPost(ctx({
    method: "POST", session: sessionA,
    form: { phoneNumberId: "TEST_PHONE_A2", accessToken: "FAKE-ACCESS-TOKEN-ALPHA-2", wabaId: "WABA-A2" },
  }), w);
  assert.equal(res.status, 302);

  const afterB = await w.integrations.forBusiness(w.bizB.id);
  assert.deepEqual(afterB, beforeB, "changing tenant A's settings mutated tenant B's integration");
});

test("claiming a phone number another tenant owns is refused without naming that tenant", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.userA);

  const res = await handleWhatsappSettingsPost(ctx({
    method: "POST", session: sessionA,
    form: { phoneNumberId: TEST_PHONE_B, accessToken: "FAKE-STOLEN" },
  }), w);

  assert.equal(res.status, 409);
  const intB = await w.integrations.forBusiness(w.bizB.id);
  assert.equal(w.integrations.secretsOf(intB).accessToken, TOKEN_B, "a claim attempt overwrote the owning tenant's credentials");
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_B)).businessId, w.bizB.id);

  const body = renderedBody(res);
  for (const identifier of [w.bizB.id, w.bizB.name, w.bizB.ownerName, "owner-b@example.test"]) {
    assert.ok(!body.includes(identifier), `the refusal named the owning tenant: ${identifier}`);
  }
});

test("a tenant cannot add itself to, or read, another tenant's team", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.userA);
  const beforeB = await w.accounts.membersOf(w.bizB.id);

  // A third person with an account, so the add is legitimate apart from
  // the business it names.
  const outsider = await w.accounts.signUp({ email: "outsider@example.test", password: "outsider-password" });

  await handleTeamPost(ctx({
    method: "POST", session: sessionA,
    form: { businessId: w.bizB.id, email: "outsider@example.test", role: "ADMIN" },
  }), w);

  assert.deepEqual(await w.accounts.membersOf(w.bizB.id), beforeB, "tenant A altered tenant B's team");
  assert.equal(await w.accounts.membershipFor(outsider.id, w.bizB.id), null, "the outsider landed in tenant B");
  assert.equal(
    (await w.accounts.membershipFor(outsider.id, w.bizA.id))?.businessId, w.bizA.id,
    "the add was redirected to the acting tenant, as intended"
  );

  const teamView = renderedBody(await handleTeamGet(ctx({ session: sessionA }), w));
  assert.ok(!teamView.includes("owner-b@example.test"), "tenant B's owner appeared in tenant A's team page");
});

// ============================== 9b. PHONE NUMBER MAPPING LIFECYCLE

test("replacing a number releases the old mapping and keeps the new one", async () => {
  const w = await buildWorld();
  const before = await w.integrations.forBusiness(w.bizA.id);

  await w.integrations.register({
    businessId: w.bizA.id, phoneNumberId: "TEST_PHONE_A_NEW", accessToken: "FAKE-ACCESS-TOKEN-ALPHA-NEW",
  });

  // The new number routes to A...
  const byNew = await w.integrations.byPhoneNumberId("TEST_PHONE_A_NEW");
  assert.equal(byNew.businessId, w.bizA.id);

  // ...and the old one routes nowhere at all.
  assert.equal(await w.integrations.byPhoneNumberId(TEST_PHONE_A), null,
    "the superseded number still resolved to a business");

  // The integration is replaced, not duplicated: same id, same creation date.
  const after = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(after.id, before.id, "re-registering created a second integration record");
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.phoneNumberId, "TEST_PHONE_A_NEW");
  assert.equal(w.integrations.secretsOf(after).accessToken, "FAKE-ACCESS-TOKEN-ALPHA-NEW");
});

test("a released number becomes available to another business", async () => {
  const w = await buildWorld();

  // A gives up TEST_PHONE_A.
  await w.integrations.register({ businessId: w.bizA.id, phoneNumberId: "TEST_PHONE_A_NEW", accessToken: "FAKE-A-NEW" });

  // B may now claim it — under the old behaviour this threw, because the
  // abandoned mapping still held the number.
  await w.integrations.register({ businessId: w.bizB.id, phoneNumberId: TEST_PHONE_A, accessToken: TOKEN_B });

  const routed = await w.integrations.byPhoneNumberId(TEST_PHONE_A);
  assert.equal(routed.businessId, w.bizB.id, "the released number did not transfer to its new owner");

  // And A is unaffected on its current number.
  assert.equal((await w.integrations.byPhoneNumberId("TEST_PHONE_A_NEW")).businessId, w.bizA.id);
});

test("releasing a number cannot remove another business's mapping", async () => {
  const w = await buildWorld();
  const intA = await w.integrations.forBusiness(w.bizA.id);
  const intB = await w.integrations.forBusiness(w.bizB.id);

  // A's integration id, aimed at B's number: the compare fails, nothing happens.
  const released = await w.store.releasePhoneNumberMapping(TEST_PHONE_B, intA.id);
  assert.equal(released, false);
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_B)).businessId, w.bizB.id,
    "one business released another's phone number mapping");

  // A plausible-looking but wrong id is equally powerless.
  assert.equal(await w.store.releasePhoneNumberMapping(TEST_PHONE_B, crypto.randomUUID()), false);
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_B)).id, intB.id);

  // Only the holder can release it.
  assert.equal(await w.store.releasePhoneNumberMapping(TEST_PHONE_B, intB.id), true);
  assert.equal(await w.integrations.byPhoneNumberId(TEST_PHONE_B), null);
});

test("re-registering the same number for the same business keeps it mapped", async () => {
  const w = await buildWorld();
  const before = await w.integrations.forBusiness(w.bizA.id);

  // Rotating only the token, number unchanged — the mapping must survive.
  await w.integrations.register({ businessId: w.bizA.id, phoneNumberId: TEST_PHONE_A, accessToken: "FAKE-ROTATED-SAME-NUMBER" });

  const routed = await w.integrations.byPhoneNumberId(TEST_PHONE_A);
  assert.ok(routed, "rotating the token unmapped the business's own number");
  assert.equal(routed.businessId, w.bizA.id);
  assert.equal(routed.id, before.id);
  assert.equal(w.integrations.secretsOf(routed).accessToken, "FAKE-ROTATED-SAME-NUMBER");
});

test("a replaced number still cannot be claimed while its owner holds it", async () => {
  const w = await buildWorld();
  await assert.rejects(
    () => w.integrations.register({ businessId: w.bizA.id, phoneNumberId: TEST_PHONE_B, accessToken: "FAKE-STOLEN" }),
    /already registered to another business/
  );
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_B)).businessId, w.bizB.id);
  // The refusal left A's own mapping alone.
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_A)).businessId, w.bizA.id);
});

test("a number swap between two businesses ends with exactly one owner each", async () => {
  const w = await buildWorld();

  // A moves off its number; B takes it; A takes a third.
  await w.integrations.register({ businessId: w.bizA.id, phoneNumberId: "TEST_PHONE_A_THIRD", accessToken: "FAKE-A3" });
  await w.integrations.register({ businessId: w.bizB.id, phoneNumberId: TEST_PHONE_A, accessToken: TOKEN_B });

  const mappings = {
    [TEST_PHONE_A]: (await w.integrations.byPhoneNumberId(TEST_PHONE_A))?.businessId ?? null,
    [TEST_PHONE_B]: (await w.integrations.byPhoneNumberId(TEST_PHONE_B))?.businessId ?? null,
    TEST_PHONE_A_THIRD: (await w.integrations.byPhoneNumberId("TEST_PHONE_A_THIRD"))?.businessId ?? null,
  };
  assert.deepEqual(mappings, {
    [TEST_PHONE_A]: w.bizB.id,
    [TEST_PHONE_B]: null,          // B released it when it moved
    TEST_PHONE_A_THIRD: w.bizA.id,
  });

  // One integration per business, still.
  assert.equal((await w.integrations.forBusiness(w.bizA.id)).phoneNumberId, "TEST_PHONE_A_THIRD");
  assert.equal((await w.integrations.forBusiness(w.bizB.id)).phoneNumberId, TEST_PHONE_A);
});

test("the default business's stored mapping survives a rotation", async () => {
  const w = await buildWorld();
  // The live tenant resolves through the env fallback in tests; registering
  // a stored integration for it must not disturb its number.
  await w.integrations.register({
    businessId: "default", phoneNumberId: TEST_CONFIG.META_PHONE_NUMBER_ID, accessToken: "FAKE-DEFAULT-STORED",
  });
  const routed = await w.integrations.byPhoneNumberId(TEST_CONFIG.META_PHONE_NUMBER_ID);
  assert.equal(routed.businessId, "default");
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_A)).businessId, w.bizA.id);
  assert.equal((await w.integrations.byPhoneNumberId(TEST_PHONE_B)).businessId, w.bizB.id);
});

// ================================================= 10. ROLE AUTHORIZATION

async function withRole(w, role, email) {
  const user = await w.accounts.signUp({ email, password: "role-test-password" });
  await w.accounts.addMember({ businessId: w.bizA.id, email, role });
  return { user, session: await sessionFor(w, user) };
}

test("role permissions are what the role matrix says", async () => {
  assert.deepEqual(
    ["OWNER", "ADMIN", "STAFF"].map((r) => [r, can(r, "viewLeads"), can(r, "manageSettings"), can(r, "manageTeam")]),
    [["OWNER", true, true, true], ["ADMIN", true, true, false], ["STAFF", true, false, false]]
  );
  assert.equal(can("SUPERUSER", "manageTeam"), false);
});

test("ADMIN may change integration settings but not the team", async () => {
  const w = await buildWorld();
  const { session } = await withRole(w, "ADMIN", "admin-a@example.test");

  const settings = await handleWhatsappSettingsPost(ctx({
    method: "POST", session, form: { phoneNumberId: "TEST_PHONE_A3", accessToken: "FAKE-ADMIN-ROTATED" },
  }), w);
  assert.equal(settings.status, 302);
  assert.equal((await w.integrations.forBusiness(w.bizA.id)).phoneNumberId, "TEST_PHONE_A3");

  const before = await w.accounts.membersOf(w.bizA.id);
  const team = await handleTeamPost(ctx({
    method: "POST", session, form: { email: "owner-b@example.test", role: "STAFF" },
  }), w);
  assert.equal(team.status, 403);
  assert.deepEqual(await w.accounts.membersOf(w.bizA.id), before, "ADMIN changed the team despite the 403");
});

test("STAFF may read leads but cannot touch credentials or the team", async () => {
  const w = await buildWorld();
  const { session } = await withRole(w, "STAFF", "staff-a@example.test");
  const before = await w.integrations.forBusiness(w.bizA.id);

  const settings = await handleWhatsappSettingsPost(ctx({
    method: "POST", session, form: { phoneNumberId: "TEST_PHONE_STAFF", accessToken: "FAKE-STAFF-ROTATED" },
  }), w);
  assert.equal(settings.status, 403);
  assert.deepEqual(await w.integrations.forBusiness(w.bizA.id), before, "STAFF rotated the integration despite the 403");

  const team = await handleTeamPost(ctx({ method: "POST", session, form: { email: "x@example.test", role: "ADMIN" } }), w);
  assert.equal(team.status, 403);

  // Direct URL access to the settings page is allowed (read-only) but must
  // not carry a usable credential.
  const page = renderedBody(await handleWhatsappSettingsGet(ctx({ session }), w));
  for (const secret of ALL_SECRETS) assert.ok(!page.includes(secret), "the settings page showed a credential to STAFF");
  assert.ok(!page.includes(before.accessTokenEncrypted), "the settings page leaked the stored ciphertext");

  // And leads remain readable, or the role would be pointless.
  const { leadA } = await seedLeads(w);
  assert.equal((await handleLeadDetail(ctx({ pathname: "/lead", session, query: { id: leadA.id } }), w)).status, 200);
});

test("a STAFF membership cannot be escalated by sending a role", async () => {
  const w = await buildWorld();
  const { user, session } = await withRole(w, "STAFF", "staff2-a@example.test");

  await handleTeamPost(ctx({ method: "POST", session, form: { email: "staff2-a@example.test", role: "OWNER" } }), w);
  const membership = await w.accounts.membershipFor(user.id, w.bizA.id);
  assert.equal(membership.role, "STAFF");

  const actor = await resolveActor(await w.store.getSession(session), w.accounts);
  assert.equal(actor.role, "STAFF");
});

test("OWNER cannot be granted through the team form, by anyone", async () => {
  const w = await buildWorld();
  assert.equal(await w.accounts.addMember({ businessId: w.bizA.id, email: "owner-b@example.test", role: "OWNER" }), null);
  assert.equal(await w.accounts.addMember({ businessId: w.bizA.id, email: "owner-b@example.test", role: "SUPERUSER" }), null);
});

// ================================================= 11. SECRET PROTECTION

test("no route response and no log line contains a credential", async () => {
  const w = await buildWorld();
  const logs = captureLogs();
  const bodies = [];

  try {
    await seedLeads(w);
    await seedConversations(w);
    const sessionA = await sessionFor(w, w.userA);
    const { leadA } = await seedLeads(w);

    const meta = mockMetaApi();
    try {
      bodies.push(renderedBody(await handleDashboard(ctx({ pathname: "/leads", session: sessionA }), w)));
      bodies.push(renderedBody(await handleLeadDetail(ctx({ pathname: "/lead", session: sessionA, query: { id: leadA.id } }), w)));
      bodies.push(renderedBody(await handleWhatsappSettingsGet(ctx({ session: sessionA }), w)));
      bodies.push(renderedBody(await handleTeamGet(ctx({ session: sessionA }), w)));
      bodies.push(renderedBody(await handleOnboardingGet(ctx({ session: sessionA }), w)));
      bodies.push(renderedBody(await handleLogin(ctx({ method: "POST", form: { email: "owner-a@example.test", password: PASSWORD_A } }), w)));
      bodies.push(renderedBody(await handleLogin(ctx({ method: "POST", form: { email: "owner-a@example.test", password: "wrong-password-here" } }), w)));
      bodies.push(renderedBody(await handleWhatsappSettingsPost(ctx({ method: "POST", session: sessionA, form: { phoneNumberId: TEST_PHONE_B, accessToken: TOKEN_A } }), w)));
      bodies.push(renderedBody(await deliver(w, webhookPayload({ phoneNumberId: TEST_PHONE_A, text: "AC not cooling", messageId: "wamid.SEC" }))));
    } finally {
      meta.restore();
    }
  } finally {
    logs.restore();
  }

  const responses = bodies.join("\n");
  const logOutput = logs.lines.join("\n");

  for (const secret of ALL_SECRETS) {
    assert.ok(!responses.includes(secret), `a response contained the credential ${secret.slice(0, 12)}…`);
    assert.ok(!logOutput.includes(secret), `a log line contained the credential ${secret.slice(0, 12)}…`);
  }

  // The stored ciphertext must not reach the browser either — encrypted is
  // not the same as safe to publish.
  const intA = await w.integrations.forBusiness(w.bizA.id);
  assert.ok(!responses.includes(intA.accessTokenEncrypted));
  assert.ok(!responses.includes(w.userA.passwordHash));
  assert.ok(!logOutput.includes(w.userA.passwordHash));

  // The words themselves appear only as form input names, never as data keys
  // carrying a value.
  for (const field of ["accessTokenEncrypted", "appSecretEncrypted", "verifyTokenEncrypted", "passwordHash"]) {
    assert.ok(!responses.includes(field), `a response exposed the field name ${field}`);
  }
});

test("publicView masks identifiers and carries no credential field at all", async () => {
  const w = await buildWorld();
  const intA = await w.integrations.forBusiness(w.bizA.id);
  const view = publicView(intA);
  const serialised = JSON.stringify(view);

  // Masked to the last four characters — enough to recognise, never enough to use.
  assert.equal(view.phoneNumberId, "*".repeat(TEST_PHONE_A.length - 4) + TEST_PHONE_A.slice(-4));
  assert.ok(!view.phoneNumberId.includes(TEST_PHONE_A));
  for (const secret of ALL_SECRETS) assert.ok(!serialised.includes(secret));
  for (const key of Object.keys(view)) assert.ok(!/token|secret|password/i.test(key), `publicView exposed key ${key}`);
  assert.equal(serialised.includes(intA.accessTokenEncrypted), false);
});

// ======================================= 12. DEFAULT BUSINESS REGRESSION

test("the default business keeps its own credentials, password and namespace", async () => {
  const w = await buildWorld();

  const def = w.businesses.byId("default");
  assert.ok(def, "the default business disappeared from the registry once other tenants existed");
  assert.equal(def.phoneNumberId, TEST_CONFIG.META_PHONE_NUMBER_ID);

  // Its integration still resolves — through the env fallback, which is
  // scoped to this one business and no other.
  const defIntegration = await w.integrations.forBusiness("default");
  assert.equal(w.integrations.secretsOf(defIntegration).accessToken, TEST_CONFIG.META_ACCESS_TOKEN);
  assert.equal(await w.integrations.forBusiness("biz-alpha") === null, false);

  // A tenant with no stored integration gets nothing, not the default's.
  const orphan = await w.integrations.forBusiness("some-other-business");
  assert.equal(orphan, null, "a business with no integration inherited the default's credentials");

  // Inbound to the default's number still routes to the default.
  const routed = await w.integrations.byPhoneNumberId(TEST_CONFIG.META_PHONE_NUMBER_ID);
  assert.equal(routed.businessId, "default");
});

test("the default business's legacy password does not open another tenant", async () => {
  const w = await buildWorld();
  const login = await handleLogin(ctx({ method: "POST", form: { password: DEFAULT_PASSWORD } }), w);
  assert.equal(login.status, 302);

  const id = /mct_session=([a-f0-9]+)/.exec(login.headers["Set-Cookie"])[1];
  const session = await w.store.getSession(id);
  assert.equal(session.businessId, "default");

  const { leadB } = await seedLeads(w);
  const detail = await handleLeadDetail(ctx({ pathname: "/lead", session: id, query: { id: leadB.id } }), w);
  assert.equal(detail.status, 404, "the default tenant could read a new tenant's lead");
});
