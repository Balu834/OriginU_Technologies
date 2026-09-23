/**
 * Subscriptions, entitlements, usage metering and limit enforcement.
 *
 * No payment provider is connected, so the thing most worth pinning down
 * is what CANNOT happen: no request can grant a plan, no tenant can read
 * or alter another's subscription or usage, and a failed operation never
 * counts as usage.
 *
 * Assertions are against stored records and route results. Nothing here
 * reads state out of markup.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService, effectivePlan, publicSubscription, PLAN_ENTITLEMENTS, defaultSubscription } from "../lib/billing.mjs";
import { createUsageService, currentPeriod, usageKey, METRICS } from "../lib/usage.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { handleBillingGet } from "../routes/billing.mjs";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const API_KEY_A = "alpha-missed-call-key";

async function buildWorld() {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "c".repeat(64), DASHBOARD_PASSWORD_HASH: hashPassword("pw-default-x") };
  const accounts = createAccountService(store);
  const integrations = createIntegrationService(store, config);
  const billing = createBillingService(store);
  const usage = createUsageService(store);

  const userA = await accounts.signUp({ email: "bill-a@example.test", password: "bill-a-password" });
  const userB = await accounts.signUp({ email: "bill-b@example.test", password: "bill-b-password" });

  const bizA = businessRecord({
    id: "bill-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: "+911111111111",
    services: ["Electrical repair"], missedCallApiKey: API_KEY_A,
    missedCallTemplate: "missed_call_immediate", templateLanguage: "en",
  });
  const bizB = businessRecord({ id: "bill-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: "+912222222222", services: ["Plumbing"] });
  await accounts.createBusinessFor(userA, bizA);
  await accounts.createBusinessFor(userB, bizB);

  await integrations.register({ businessId: bizA.id, phoneNumberId: "PHONE_BILL_A", wabaId: "WABA_A", accessToken: "FAKE-BILL-A" });

  const businesses = await loadBusinessRegistry(store, config);
  return { store, config, accounts, integrations, billing, usage, businesses, wa: createFakeWa(), templates, userA, userB, bizA, bizB };
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

const getCtx = (session, query = {}) => ({
  method: "GET", pathname: "/settings/billing",
  query: new URLSearchParams(query),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
  rawBody: Buffer.alloc(0),
});

const missedCallCtx = (apiKey, caller = "+919000000123") => ({
  method: "POST", pathname: "/missed-call", query: new URLSearchParams(),
  headers: { authorization: `Bearer ${apiKey}` },
  rawBody: Buffer.alloc(0),
  json: { callerNumber: caller, timestamp: new Date().toISOString() },
});

/** Replaces fetch so the missed-call send succeeds without touching Meta. */
function mockMeta({ fail = false } = {}) {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => ({
    ok: !fail, status: fail ? 400 : 200,
    json: async () => (fail
      ? { error: { message: "nope", code: 131030 } }
      : { messaging_product: "whatsapp", messages: [{ id: `wamid.BILL${++n}` }] }),
  });
  return { restore: () => { globalThis.fetch = original; } };
}

// ------------------------------------------------- model + entitlements

test("every business has a subscription before anyone has paid", async () => {
  const w = await buildWorld();
  const sub = await w.billing.forBusiness(w.bizA.id);

  assert.equal(sub.plan, "FREE");
  assert.equal(sub.status, "ACTIVE");
  assert.equal(sub.provider, "none");
  assert.equal(sub.providerCustomerId, null);
  assert.equal(sub.providerSubscriptionId, null);
  assert.equal(sub.implicit, true, "an assumed subscription must say so");
  assert.equal(sub.businessId, w.bizA.id);
});

test("the default business resolves to FREE/ACTIVE, not a paid plan", async () => {
  const w = await buildWorld();
  const sub = await w.billing.forBusiness("default");
  assert.equal(sub.plan, "FREE");
  assert.equal(sub.status, "ACTIVE");
  assert.equal(sub.implicit, true);

  const ent = await w.billing.getBusinessEntitlements("default");
  assert.equal(ent.plan, "FREE");
  assert.deepEqual(ent.limits, PLAN_ENTITLEMENTS.FREE);
});

test("entitlements come from the plan, and a lapsed subscription falls back to FREE", async () => {
  const w = await buildWorld();

  await w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", reason: "test" });
  let ent = await w.billing.getBusinessEntitlements(w.bizA.id);
  assert.equal(ent.plan, "PRO");
  assert.equal(ent.limits.leadsPerMonth, PLAN_ENTITLEMENTS.PRO.leadsPerMonth);

  for (const status of ["PAST_DUE", "CANCELED", "EXPIRED"]) {
    await w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", status, reason: "test" });
    ent = await w.billing.getBusinessEntitlements(w.bizA.id);
    assert.equal(ent.plan, "FREE", `${status} kept granting PRO`);
    assert.equal(ent.nominalPlan, "PRO");
    assert.deepEqual(ent.limits, PLAN_ENTITLEMENTS.FREE);
  }

  // TRIALING is honoured — a trial is a plan you are genuinely on.
  await w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", status: "TRIALING", reason: "test" });
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "PRO");
});

test("BUSINESS plan means no limit, not a large number", async () => {
  const w = await buildWorld();
  await w.billing.changePlan({ businessId: w.bizA.id, plan: "BUSINESS", reason: "test" });
  const ent = await w.billing.getBusinessEntitlements(w.bizA.id);
  assert.equal(ent.limits.leadsPerMonth, null);
  assert.equal(ent.limits.messagesPerMonth, null);

  const check = await w.usage.check(w.bizA.id, "messages", ent);
  assert.equal(check.allowed, true);
  assert.equal(check.limit, null);
});

test("an unknown plan or status is refused rather than stored", async () => {
  const w = await buildWorld();
  await assert.rejects(() => w.billing.changePlan({ businessId: w.bizA.id, plan: "ENTERPRISE" }), /unknown plan/);
  await assert.rejects(() => w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", status: "COMPED" }), /unknown subscription status/);
  await assert.rejects(() => w.billing.changePlan({ plan: "PRO" }), /requires a businessId/);
  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "FREE");
});

test("effectivePlan treats a missing or malformed subscription as FREE", () => {
  assert.equal(effectivePlan(null), "FREE");
  assert.equal(effectivePlan({ plan: "SUPER", status: "ACTIVE" }), "FREE");
  assert.equal(effectivePlan(defaultSubscription("x")), "FREE");
});

// --------------------------------------------------------- usage

test("usage counters are per business, per metric, per period", async () => {
  const w = await buildWorld();

  await w.usage.record(w.bizA.id, "leads", 1);
  await w.usage.record(w.bizA.id, "leads", 1);
  await w.usage.record(w.bizA.id, "messages", 1);

  assert.equal(await w.usage.count(w.bizA.id, "leads"), 2);
  assert.equal(await w.usage.count(w.bizA.id, "messages"), 1);
  assert.equal(await w.usage.count(w.bizB.id, "leads"), 0, "one tenant's usage leaked into another's counter");

  const summary = await w.usage.summary(w.bizA.id);
  assert.deepEqual(summary.counts, { leads: 2, messages: 1 });
  assert.equal(summary.businessId, w.bizA.id);
});

test("a usage key always names the business, and an unknown metric is refused", () => {
  const { periodStart } = currentPeriod(new Date("2026-09-23T10:00:00Z"));
  assert.equal(usageKey("biz-x", "leads", periodStart), `usage:b:biz-x:leads:${periodStart}`);
  assert.throws(() => usageKey("", "leads", periodStart), /always per business/);
  assert.throws(() => usageKey("biz-x", "ai_requests", periodStart), /unknown usage metric/);
  assert.deepEqual(METRICS, ["leads", "messages"]);
});

test("periods are UTC calendar months and counters do not bleed across them", async () => {
  const w = await buildWorld();
  let now = new Date("2026-09-30T23:00:00Z");
  const usage = createUsageService(w.store, { clock: () => now });

  await usage.record(w.bizA.id, "leads", 5);
  assert.equal(await usage.count(w.bizA.id, "leads"), 5);

  now = new Date("2026-10-01T01:00:00Z"); // new month
  assert.equal(await usage.count(w.bizA.id, "leads"), 0, "the counter carried into the next period");

  now = new Date("2026-09-30T23:30:00Z"); // back inside September
  assert.equal(await usage.count(w.bizA.id, "leads"), 5, "the previous period's count was lost");
});

test("concurrent increments do not lose counts", async () => {
  const w = await buildWorld();
  await Promise.all(Array.from({ length: 50 }, () => w.usage.record(w.bizA.id, "messages", 1)));
  assert.equal(await w.usage.count(w.bizA.id, "messages"), 50);

  // And the returned totals are all distinct — each caller saw its own step.
  const totals = await Promise.all(Array.from({ length: 20 }, () => w.usage.record(w.bizB.id, "leads", 1)));
  assert.equal(new Set(totals).size, 20, "two increments returned the same total");
  assert.equal(await w.usage.count(w.bizB.id, "leads"), 20);
});

test("check() compares usage against the plan's limit", async () => {
  const w = await buildWorld();
  const free = await w.billing.getBusinessEntitlements(w.bizA.id);
  const limit = PLAN_ENTITLEMENTS.FREE.messagesPerMonth;

  let check = await w.usage.check(w.bizA.id, "messages", free);
  assert.deepEqual([check.allowed, check.used, check.limit, check.remaining], [true, 0, limit, limit]);

  await w.usage.record(w.bizA.id, "messages", limit - 1);
  check = await w.usage.check(w.bizA.id, "messages", free);
  assert.equal(check.allowed, true);
  assert.equal(check.remaining, 1);

  await w.usage.record(w.bizA.id, "messages", 1);
  check = await w.usage.check(w.bizA.id, "messages", free);
  assert.equal(check.allowed, false, "the limit was not enforced at exactly the limit");
  assert.equal(check.remaining, 0);
});

// ----------------------------------------------- server-side enforcement

test("a business over its limit is refused before anything is sent", async () => {
  const w = await buildWorld();
  await w.usage.record(w.bizA.id, "messages", PLAN_ENTITLEMENTS.FREE.messagesPerMonth);

  const meta = mockMeta();
  let res;
  try {
    res = await handleMissedCall(missedCallCtx(API_KEY_A), w);
  } finally {
    meta.restore();
  }

  assert.equal(res.status, 402);
  assert.equal(res.body.sent, false);
  assert.match(res.body.error, /limit/i);
  assert.equal(res.body.plan, "FREE");

  // No partial state: the dedupe marker was never written, so a retry
  // after an upgrade still works.
  const scoped = (await import("../lib/store.redis.mjs")).scopedToBusiness(w.store, w.bizA.id);
  assert.equal(await scoped.lastMissedCallAt("+919000000123"), null);
  assert.equal(w.wa.sent.length, 0);
});

test("under the limit the send proceeds and is counted once", async () => {
  const w = await buildWorld();
  const meta = mockMeta();
  let res;
  try {
    res = await handleMissedCall(missedCallCtx(API_KEY_A), w);
  } finally {
    meta.restore();
  }

  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.equal(await w.usage.count(w.bizA.id, "messages"), 1);
  assert.equal(await w.usage.count(w.bizB.id, "messages"), 0);
});

test("a failed send is not counted as usage", async () => {
  const w = await buildWorld();
  const meta = mockMeta({ fail: true });
  let res;
  try {
    res = await handleMissedCall(missedCallCtx(API_KEY_A), w);
  } finally {
    meta.restore();
  }

  assert.equal(res.status, 502);
  assert.equal(res.body.sent, false);
  assert.equal(await w.usage.count(w.bizA.id, "messages"), 0, "a failed send was billed");
});

test("raising the plan restores service without any code change", async () => {
  const w = await buildWorld();
  await w.usage.record(w.bizA.id, "messages", PLAN_ENTITLEMENTS.FREE.messagesPerMonth);

  const meta = mockMeta();
  try {
    assert.equal((await handleMissedCall(missedCallCtx(API_KEY_A), w)).status, 402);
    await w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", reason: "test" });
    assert.equal((await handleMissedCall(missedCallCtx(API_KEY_A), w)).status, 200);
  } finally {
    meta.restore();
  }
});

// ------------------------------------------------ tampering + isolation

test("a plan sent by the client is never read", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  // Every shape a client could try: query string, and a body on a route
  // that does not even accept POST.
  const res = await handleBillingGet(getCtx(session, { plan: "BUSINESS", businessId: w.bizB.id }), w);
  assert.equal(res.status, 200);

  const stored = await w.billing.forBusiness(w.bizA.id);
  assert.equal(stored.plan, "FREE", "a query parameter changed the plan");
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");
});

test("there is no route that can change a plan", async () => {
  const { dispatch } = await import("../routes/router.mjs");
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const attempt = await dispatch({
    method: "POST", pathname: "/settings/billing", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${session}` },
    rawBody: Buffer.from("plan=BUSINESS"),
  }, w);

  assert.equal(attempt, null, "POST /settings/billing is routable");
  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "FREE");
});

test("one tenant cannot read another's subscription or usage through the route", async () => {
  const w = await buildWorld();
  await w.billing.changePlan({ businessId: w.bizB.id, plan: "BUSINESS", reason: "test" });
  await w.usage.record(w.bizB.id, "leads", 17);

  const sessionA = await sessionFor(w, w.userA);
  const res = await handleBillingGet(getCtx(sessionA, { businessId: w.bizB.id }), w);
  assert.equal(res.status, 200);

  // The assertions that matter are about resolved data, not markup: A got
  // A's plan and A's counters despite naming B in the query string.
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");
  assert.deepEqual((await w.usage.summary(w.bizA.id)).counts, { leads: 0, messages: 0 });
  assert.equal((await w.usage.summary(w.bizB.id)).counts.leads, 17, "B's own usage should be untouched");

  // Two narrow leak checks on the rendered page. Tenant B's NAME is safe
  // to search for; a bare number is not — "17" also appears inside the
  // stylesheet's #2a1714, which is how this assertion first failed for the
  // wrong reason.
  assert.ok(!res.html.includes("Beta Plumbing"), "tenant B's name appeared on tenant A's billing page");
  assert.ok(!/BUSINESS \(current\)/.test(res.html), "tenant B's plan was shown as tenant A's current plan");
});

test("usage recorded for one tenant never moves another tenant toward its limit", async () => {
  const w = await buildWorld();
  const free = await w.billing.getBusinessEntitlements(w.bizB.id);

  await w.usage.record(w.bizA.id, "messages", PLAN_ENTITLEMENTS.FREE.messagesPerMonth + 10);

  const checkB = await w.usage.check(w.bizB.id, "messages", free);
  assert.equal(checkB.allowed, true);
  assert.equal(checkB.used, 0, "tenant A's usage counted against tenant B");
});

test("a session with no business gets no entitlements page", async () => {
  const w = await buildWorld();
  const stranger = await w.accounts.signUp({ email: "nobody-bill@example.test", password: "nobody-password" });
  const session = await createSession(w.store, null, { userId: stranger.id });

  const res = await handleBillingGet(getCtx(session), w);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/onboarding");
});

test("publicSubscription carries no provider identifiers", async () => {
  const w = await buildWorld();
  await w.billing.changePlan({
    businessId: w.bizA.id, plan: "PRO", provider: "razorpay",
    providerCustomerId: "cust_SECRET123", providerSubscriptionId: "sub_SECRET456", reason: "test",
  });

  const view = publicSubscription(await w.billing.forBusiness(w.bizA.id));
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes("cust_SECRET123"), "a provider customer id reached the view");
  assert.ok(!serialised.includes("sub_SECRET456"), "a provider subscription id reached the view");
  assert.equal(view.plan, "PRO");

  const session = await sessionFor(w, w.userA);
  const page = (await handleBillingGet(getCtx(session), w)).html;
  assert.ok(!page.includes("cust_SECRET123"));
  assert.ok(!page.includes("sub_SECRET456"));
});

test("a plan change records why it happened", async () => {
  const w = await buildWorld();
  const record = await w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", reason: "manual grant during pilot" });
  assert.equal(record.changeReason, "manual grant during pilot");
  assert.equal(record.implicit, false);
  assert.equal((await w.store.getSubscription(w.bizA.id)).changeReason, "manual grant during pilot");
});
