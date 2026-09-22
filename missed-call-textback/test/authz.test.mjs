/**
 * Cross-tenant authorization.
 *
 * Every case here attacks the boundary directly: a signed-in tenant using
 * another tenant's ids. Isolation is structural — the business id is part
 * of every storage key — so these assert that no route reintroduces a way
 * around it, and that the browser never gets to nominate a tenant.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { createBusinessRegistry, businessFromConfig, businessContext } from "../lib/businesses.mjs";
import {
  handleDashboard, handleLeadDetail, handleLeadStatus,
  handleLeadPriority, handleRetryNotification, handleLogin,
} from "../routes/dashboard.mjs";
import { createSession, hashPassword, verifyPassword, COOKIE_NAME } from "../lib/auth.mjs";
import { createFakeWa, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const A_PASSWORD = "acme-dashboard-password";
const B_PASSWORD = "bolt-dashboard-password";

const ACME = {
  id: "acme", name: "Acme Electrical", ownerName: "Anil", ownerWhatsApp: "+919000000111",
  phoneNumberId: "111111", missedCallApiKey: "acme-key", passwordHash: hashPassword(A_PASSWORD),
  missedCallTemplate: "t", templateLanguage: "en", status: "active",
};
const BOLT = {
  id: "bolt", name: "Bolt Services", ownerName: "Bhavna", ownerWhatsApp: "+919000000222",
  phoneNumberId: "222222", missedCallApiKey: "bolt-key", passwordHash: hashPassword(B_PASSWORD),
  missedCallTemplate: "t", templateLanguage: "en", status: "active",
};

const B_LEAD = {
  id: "bolt-lead-1", callerNumber: "+919505141818", name: "Bolt Customer",
  area: "Secret Area", problem: "Secret problem", urgency: "today",
  summary: "Bolt's private lead.", status: "new", ownerNotified: false,
  createdAt: new Date().toISOString(),
};

function deps() {
  const store = createStore(null);
  return {
    store,
    businesses: createBusinessRegistry([ACME, BOLT]),
    wa: createFakeWa(),
    templates,
    config: { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("unused") },
  };
}

const form = (f) => Buffer.from(new URLSearchParams(f).toString());
const cookieFor = async (d, businessId) => `${COOKIE_NAME}=${await createSession(d.store, businessId)}`;

async function seedBoltLead(d) {
  const bolt = scopedToBusiness(d.store, "bolt");
  await bolt.saveLead({ ...B_LEAD });
  await bolt.saveMessage({
    id: "bolt-msg-1", conversationId: B_LEAD.callerNumber, direction: "inbound",
    senderType: "customer", customerPhone: B_LEAD.callerNumber, text: "Bolt private transcript",
  });
  return bolt;
}

// ---- A. unauthenticated ----

test("A: unauthenticated dashboard access is refused", async () => {
  const d = deps();
  await seedBoltLead(d);
  const res = await handleDashboard({ headers: {}, query: new URLSearchParams() }, d);
  assert.match(res.html, /type="password"/);
  assert.doesNotMatch(res.html, /Bolt Customer/);
});

test("A: unauthenticated lead detail is refused", async () => {
  const d = deps();
  await seedBoltLead(d);
  const res = await handleLeadDetail({ headers: {}, query: new URLSearchParams({ id: B_LEAD.id }) }, d);
  assert.match(res.html, /type="password"/);
  assert.doesNotMatch(res.html, /Secret problem/);
});

test("A: unauthenticated writes change nothing", async () => {
  const d = deps();
  const bolt = await seedBoltLead(d);
  await handleLeadStatus({ headers: {}, rawBody: form({ id: B_LEAD.id, status: "lost" }) }, d);
  await handleLeadPriority({ headers: {}, rawBody: form({ id: B_LEAD.id, priority: "URGENT" }) }, d);
  await handleRetryNotification({ headers: {}, rawBody: form({ id: B_LEAD.id }) }, d);

  const lead = await bolt.getLead(B_LEAD.id);
  assert.equal(lead.status, "new");
  assert.equal(lead.priority, undefined);
  assert.equal(lead.ownerNotified, false);
  assert.equal(d.wa.sent.length, 0);
});

// ---- B. own tenant works ----

test("B: a tenant can read its own lead", async () => {
  const d = deps();
  await seedBoltLead(d);
  const res = await handleLeadDetail(
    { headers: { cookie: await cookieFor(d, "bolt") }, query: new URLSearchParams({ id: B_LEAD.id }) }, d
  );
  assert.equal(res.status, 200);
  assert.match(res.html, /Bolt Customer/);
});

// ---- C/D/E/F. cross-tenant ----

test("C: tenant A cannot read tenant B's lead by id", async () => {
  const d = deps();
  await seedBoltLead(d);
  const res = await handleLeadDetail(
    { headers: { cookie: await cookieFor(d, "acme") }, query: new URLSearchParams({ id: B_LEAD.id }) }, d
  );
  assert.equal(res.status, 404, "must not distinguish 'not yours' from 'does not exist'");
  assert.doesNotMatch(res.html, /Bolt Customer|Secret problem|Secret Area/);
});

test("C: the 404 for another tenant's lead is identical to a nonexistent one", async () => {
  const d = deps();
  await seedBoltLead(d);
  const cookie = await cookieFor(d, "acme");
  const other = await handleLeadDetail({ headers: { cookie }, query: new URLSearchParams({ id: B_LEAD.id }) }, d);
  const absent = await handleLeadDetail({ headers: { cookie }, query: new URLSearchParams({ id: "no-such-lead" }) }, d);
  assert.equal(other.status, absent.status, "existence must not leak through the status code");
});

test("D: tenant A cannot update tenant B's lead status", async () => {
  const d = deps();
  const bolt = await seedBoltLead(d);
  await handleLeadStatus(
    { headers: { cookie: await cookieFor(d, "acme") }, rawBody: form({ id: B_LEAD.id, status: "lost" }) }, d
  );
  assert.equal((await bolt.getLead(B_LEAD.id)).status, "new");
});

test("D: tenant A cannot change tenant B's lead priority", async () => {
  const d = deps();
  const bolt = await seedBoltLead(d);
  await handleLeadPriority(
    { headers: { cookie: await cookieFor(d, "acme") }, rawBody: form({ id: B_LEAD.id, priority: "URGENT" }) }, d
  );
  assert.equal((await bolt.getLead(B_LEAD.id)).priority, undefined);
});

test("E: tenant A cannot read tenant B's conversation transcript", async () => {
  const d = deps();
  await seedBoltLead(d);
  const acme = scopedToBusiness(d.store, "acme");
  assert.deepEqual(await acme.listMessages(B_LEAD.callerNumber), [],
    "the same customer number must not expose another tenant's messages");
});

test("E: tenant A cannot reach tenant B's message by provider id", async () => {
  const d = deps();
  const bolt = await seedBoltLead(d);
  await bolt.saveMessage({
    id: "bolt-msg-2", conversationId: B_LEAD.callerNumber, messageId: "wamid.BOLTSECRET",
    direction: "outbound", senderType: "assistant", customerPhone: B_LEAD.callerNumber, text: "private",
  });
  const acme = scopedToBusiness(d.store, "acme");
  assert.equal(await acme.findMessageByProviderId("wamid.BOLTSECRET"), null);
});

test("F: tenant A cannot trigger a notification retry on tenant B's lead", async () => {
  const d = deps();
  const bolt = await seedBoltLead(d);
  await handleRetryNotification(
    { headers: { cookie: await cookieFor(d, "acme") }, rawBody: form({ id: B_LEAD.id }) }, d
  );
  assert.equal((await bolt.getLead(B_LEAD.id)).ownerNotified, false);
  assert.equal(d.wa.sent.length, 0, "no message may be sent on another tenant's behalf");
});

// ---- G. browser cannot nominate a tenant ----

test("G: a businessId in the query string cannot override the session's tenant", async () => {
  const d = deps();
  await seedBoltLead(d);
  const res = await handleDashboard(
    { headers: { cookie: await cookieFor(d, "acme") },
      query: new URLSearchParams({ businessId: "bolt", tenant: "bolt" }) }, d
  );
  assert.doesNotMatch(res.html, /Bolt Customer/);
});

test("G: a businessId in the form body cannot override the session's tenant", async () => {
  const d = deps();
  const bolt = await seedBoltLead(d);
  await handleLeadStatus(
    { headers: { cookie: await cookieFor(d, "acme") },
      rawBody: form({ id: B_LEAD.id, status: "lost", businessId: "bolt" }) }, d
  );
  assert.equal((await bolt.getLead(B_LEAD.id)).status, "new");
});

test("G: the credential decides the tenant — B's password yields B's session", async () => {
  const d = deps();
  const res = await handleLogin({ headers: {}, rawBody: form({ password: B_PASSWORD }) }, d);
  assert.equal(res.status, 302);
  const id = res.headers["Set-Cookie"].split(";")[0].split("=")[1];
  assert.equal((await d.store.getSession(id)).businessId, "bolt");
});

test("G: A's password never yields a session for B", async () => {
  const d = deps();
  const res = await handleLogin({ headers: {}, rawBody: form({ password: A_PASSWORD }) }, d);
  const id = res.headers["Set-Cookie"].split(";")[0].split("=")[1];
  assert.equal((await d.store.getSession(id)).businessId, "acme");
});

test("G: an unknown password authenticates as no tenant at all", async () => {
  const d = deps();
  const res = await handleLogin({ headers: {}, rawBody: form({ password: "not-either-password" }) }, d);
  assert.equal(res.status, 401);
  assert.equal(res.headers?.["Set-Cookie"], undefined);
});

// ---- I. secrets ----

test("I: business context carries no credentials", () => {
  const ctx = businessContext(BOLT);
  const json = JSON.stringify(ctx);
  assert.ok(!json.includes("bolt-key"));
  assert.ok(!json.includes(BOLT.passwordHash));
});

test("I: no rendered page contains Meta credentials", async () => {
  const d = deps();
  await seedBoltLead(d);
  const cookie = await cookieFor(d, "bolt");
  const pages = [
    (await handleDashboard({ headers: { cookie }, query: new URLSearchParams() }, d)).html,
    (await handleLeadDetail({ headers: { cookie }, query: new URLSearchParams({ id: B_LEAD.id }) }, d)).html,
    (await handleDashboard({ headers: {}, query: new URLSearchParams() }, d)).html,
  ];
  for (const html of pages) {
    assert.ok(!html.includes(TEST_CONFIG.META_ACCESS_TOKEN));
    assert.ok(!html.includes(TEST_CONFIG.META_APP_SECRET));
    assert.ok(!html.includes(TEST_CONFIG.MISSED_CALL_API_KEY));
    assert.ok(!html.includes("passwordHash"));
  }
});

// ---- J. the existing default business ----

test("J: the env-configured default business still authenticates and resolves", async () => {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("default-pw") };
  const d = {
    store, businesses: createBusinessRegistry([businessFromConfig(config)]),
    wa: createFakeWa(), templates, config,
  };
  await scopedToBusiness(store, "default").saveLead({ ...B_LEAD, id: "default-lead", name: "Balu" });

  const login = await handleLogin({ headers: {}, rawBody: form({ password: "default-pw" }) }, d);
  assert.equal(login.status, 302);
  const id = login.headers["Set-Cookie"].split(";")[0].split("=")[1];
  assert.equal((await store.getSession(id)).businessId, "default");

  const res = await handleDashboard(
    { headers: { cookie: `${COOKIE_NAME}=${id}` }, query: new URLSearchParams() }, d
  );
  assert.match(res.html, /Balu/, "the existing default business must keep working");
});

test("J: byPassword resolves the right tenant and rejects the wrong password", () => {
  const registry = createBusinessRegistry([ACME, BOLT]);
  assert.equal(registry.byPassword(A_PASSWORD, verifyPassword).id, "acme");
  assert.equal(registry.byPassword(B_PASSWORD, verifyPassword).id, "bolt");
  assert.equal(registry.byPassword("wrong", verifyPassword), null);
  assert.equal(registry.byPassword("", verifyPassword), null);
});
