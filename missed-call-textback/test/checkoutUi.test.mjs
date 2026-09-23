/**
 * The browser checkout layer.
 *
 * The property under test is that adding a payment widget did not create
 * a second way to become PRO. The widget can be opened, closed, succeed
 * or fail, and in every case the plan is whatever the server says — and
 * only the verified webhook changes that.
 *
 * Assertions are against route results, stored records and the status
 * API. The few checks that read the rendered page are looking for the
 * ABSENCE of a secret, or for whether a script was shipped at all, which
 * is a property of the page rather than of its wording.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService } from "../lib/billing.mjs";
import { createUsageService } from "../lib/usage.mjs";
import { createRazorpayClient } from "../lib/razorpay.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleBillingGet } from "../routes/billing.mjs";
import { handleBillingStatus } from "../routes/billingStatus.mjs";
import { handleCreateSubscription } from "../routes/billingCheckout.mjs";
import { handleRazorpayWebhook } from "../routes/razorpayWebhook.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const KEY_ID = "rzp_test_UIKEYID";
const KEY_SECRET = "FAKE-UI-KEY-SECRET";
const WEBHOOK_SECRET = "FAKE-UI-WEBHOOK-SECRET";
const PRO_PLAN_ID = "plan_UIPRO";
const SUB_ID = "sub_UI0000001";

const RZP = { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, planIds: { PRO: PRO_PLAN_ID } };
const UNCONFIGURED = { keyId: "", keySecret: "", webhookSecret: "", planIds: { PRO: "" } };

function mockApi({ subscriptionId = SUB_ID } = {}) {
  const created = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/plans/")) {
      return { ok: true, status: 200, json: async () => ({ id: PRO_PLAN_ID, period: "monthly", item: { amount: 29900, currency: "INR" } }) };
    }
    created.push(JSON.parse(options.body ?? "{}"));
    return { ok: true, status: 200, json: async () => ({ id: subscriptionId, status: "created" }) };
  };
  return { created, fetchImpl };
}

async function buildWorld({ razorpay = RZP, api = mockApi() } = {}) {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "e".repeat(64), DASHBOARD_PASSWORD_HASH: hashPassword("pw-ui") };
  const accounts = createAccountService(store);
  const billing = createBillingService(store);
  const usage = createUsageService(store);

  const owner = await accounts.signUp({ email: "ui-owner@example.test", password: "ui-owner-password" });
  const other = await accounts.signUp({ email: "ui-other@example.test", password: "ui-other-password" });
  const bizA = businessRecord({ id: "ui-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: "+911", services: ["x"] });
  const bizB = businessRecord({ id: "ui-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: "+912", services: ["y"] });
  await accounts.createBusinessFor(owner, bizA);
  await accounts.createBusinessFor(other, bizB);

  const businesses = await loadBusinessRegistry(store, config);
  return {
    store, config, accounts, billing, usage, businesses, templates, wa: createFakeWa(),
    razorpay, razorpayClient: createRazorpayClient(razorpay, { fetchImpl: api.fetchImpl }),
    api, owner, other, bizA, bizB,
  };
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

const pageCtx = (session) => ({
  method: "GET", pathname: "/settings/billing", query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {}, rawBody: Buffer.alloc(0),
});
const statusCtx = (session) => ({
  method: "GET", pathname: "/billing/status", query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {}, rawBody: Buffer.alloc(0),
});
const buyCtx = (session, body = { plan: "PRO" }) => ({
  method: "POST", pathname: "/billing/create-subscription", query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {}, rawBody: Buffer.from(JSON.stringify(body)),
});

/** A signed activation webhook, the only thing that can grant PRO. */
function activationCtx(subscriptionId = SUB_ID, secret = WEBHOOK_SECRET) {
  const payload = {
    id: `evt_ui_${subscriptionId}`,
    event: "subscription.activated",
    payload: { subscription: { entity: { id: subscriptionId, status: "active", current_start: 1790000000, current_end: 1792592000 } } },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    method: "POST", rawBody,
    headers: { "x-razorpay-signature": crypto.createHmac("sha256", secret).update(rawBody).digest("hex") },
  };
}

// ------------------------------------------------------- billing page

test("the billing page renders for a signed-in owner and ships checkout only when buyable", async () => {
  const configured = await buildWorld();
  const ownerSession = await sessionFor(configured, configured.owner);

  const withProvider = await handleBillingGet(pageCtx(ownerSession), configured);
  assert.equal(withProvider.status, 200);
  assert.ok(withProvider.html.includes("checkout.razorpay.com"), "a buyable page shipped no checkout script");
  assert.ok(withProvider.html.includes('id="upgrade-PRO"'));

  // With no provider configured there is no button and no payment code.
  const bare = await buildWorld({ razorpay: UNCONFIGURED });
  const bareSession = await sessionFor(bare, bare.owner);
  const without = await handleBillingGet(pageCtx(bareSession), bare);
  assert.equal(without.status, 200);
  assert.ok(!without.html.includes("checkout.razorpay.com"), "an unbuyable page shipped checkout code");
  assert.ok(!without.html.includes('id="upgrade-PRO"'));
});

test("a PRO business is not offered another subscription", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);
  await w.billing.changePlan({ businessId: w.bizA.id, plan: "PRO", reason: "test" });

  const res = await handleBillingGet(pageCtx(session), w);
  assert.ok(!res.html.includes('id="upgrade-PRO"'), "a PRO business was offered an upgrade");
  assert.ok(!res.html.includes("checkout.razorpay.com"));
});

test("the page and its script never carry a secret", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);
  const html = (await handleBillingGet(pageCtx(session), w)).html;

  for (const secret of [KEY_SECRET, WEBHOOK_SECRET]) {
    assert.ok(!html.includes(secret), "a secret was rendered into the billing page");
  }
  // The public key is NOT embedded in the page either — it arrives with
  // the create-subscription response, so the page alone discloses nothing.
  assert.ok(!html.includes(KEY_ID));
});

// ------------------------------------------------------ status endpoint

test("status derives the business from the session and returns safe fields only", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);

  const res = await handleBillingStatus(statusCtx(session), w);
  assert.equal(res.status, 200);
  assert.equal(res.body.plan, "FREE");
  assert.equal(res.body.pending, false);
  assert.deepEqual(res.body.usage, { leads: 0, messages: 0 });
  assert.equal(res.body.limits.leadsPerMonth, 25);

  const serialised = JSON.stringify(res.body);
  for (const secret of [KEY_SECRET, WEBHOOK_SECRET, KEY_ID, PRO_PLAN_ID, SUB_ID]) {
    assert.ok(!serialised.includes(secret), "status leaked a provider value");
  }
  assert.ok(!serialised.includes("providerSubscriptionId"));
});

test("status refuses an unauthenticated or business-less caller", async () => {
  const w = await buildWorld();
  assert.equal((await handleBillingStatus(statusCtx(null), w)).status, 401);

  const stranger = await w.accounts.signUp({ email: "ui-none@example.test", password: "ui-none-password" });
  const session = await createSession(w.store, null, { userId: stranger.id });
  assert.equal((await handleBillingStatus(statusCtx(session), w)).status, 403);
});

test("status reports each tenant's own plan", async () => {
  const w = await buildWorld();
  await w.billing.changePlan({ businessId: w.bizB.id, plan: "PRO", reason: "test" });

  const a = await handleBillingStatus(statusCtx(await sessionFor(w, w.owner)), w);
  const b = await handleBillingStatus(statusCtx(await sessionFor(w, w.other)), w);
  assert.equal(a.body.plan, "FREE");
  assert.equal(b.body.plan, "PRO");
});

// ------------------------------------------------------- upgrade flow

test("checkout returns only what the widget needs", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);

  const res = await handleCreateSubscription(buyCtx(session), w);
  assert.equal(res.status, 200);
  assert.equal(res.body.subscriptionId, SUB_ID);
  assert.equal(res.body.keyId, KEY_ID);
  assert.equal(res.body.displayPrice, "₹299 / month");
  assert.equal(res.body.activated, false);

  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes(KEY_SECRET), "the key secret reached the browser");
  assert.ok(!serialised.includes(WEBHOOK_SECRET), "the webhook secret reached the browser");
  assert.ok(!serialised.includes(PRO_PLAN_ID), "the razorpay plan id reached the browser");
});

test("the browser cannot supply a tenant, a plan id, a price or a currency", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);

  await handleCreateSubscription(buyCtx(session, {
    plan: "PRO", businessId: w.bizB.id, plan_id: "plan_ATTACKER",
    amountPaise: 1, currency: "USD", price: 1, status: "ACTIVE",
  }), w);

  assert.equal(w.api.created[0].plan_id, PRO_PLAN_ID, "the client chose the plan id");
  assert.equal(await w.store.getBusinessByProviderSubscription(SUB_ID), w.bizA.id, "the client redirected the tenant");
  assert.equal((await w.billing.forBusiness(w.bizB.id)).implicit, true);
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");
});

test("an unauthenticated caller cannot start checkout", async () => {
  const w = await buildWorld();
  assert.equal((await handleCreateSubscription(buyCtx(null), w)).status, 401);
  assert.equal(w.api.created.length, 0);
});

// ----------------------------------------- the widget cannot grant PRO

test("finishing checkout does not activate PRO; only the webhook does", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);

  // The whole browser-side flow: start checkout, widget reports success.
  const started = await handleCreateSubscription(buyCtx(session), w);
  assert.equal(started.body.activated, false);

  // Exactly what the page does next — ask the server.
  let status = await handleBillingStatus(statusCtx(session), w);
  assert.equal(status.body.plan, "FREE", "the widget's success granted PRO");
  assert.equal(status.body.pending, true, "a started checkout was not reported as pending");
  assert.equal(status.body.pendingPlan, "PRO");

  // Now the webhook arrives.
  await handleRazorpayWebhook(activationCtx(), w);

  status = await handleBillingStatus(statusCtx(session), w);
  assert.equal(status.body.plan, "PRO");
  assert.equal(status.body.status, "ACTIVE");
  assert.equal(status.body.pending, false);
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).limits.leadsPerMonth, 500);
});

test("an unsigned or wrongly signed confirmation leaves the plan alone", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);
  await handleCreateSubscription(buyCtx(session), w);

  await handleRazorpayWebhook({ method: "POST", headers: {}, rawBody: activationCtx().rawBody }, w);
  await handleRazorpayWebhook(activationCtx(SUB_ID, "not-the-secret"), w);

  assert.equal((await handleBillingStatus(statusCtx(session), w)).body.plan, "FREE");
});

test("abandoning checkout leaves the business on FREE indefinitely", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);
  await handleCreateSubscription(buyCtx(session), w);

  // No webhook ever arrives — the customer closed the widget.
  const status = await handleBillingStatus(statusCtx(session), w);
  assert.equal(status.body.plan, "FREE");
  assert.equal(status.body.pending, true);
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");
});

test("a webhook arriving before the browser callback still works", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);
  await handleCreateSubscription(buyCtx(session), w);

  // Webhook first, browser polls afterwards — the order is not assumed.
  await handleRazorpayWebhook(activationCtx(), w);
  const status = await handleBillingStatus(statusCtx(session), w);
  assert.equal(status.body.plan, "PRO");
});

// -------------------------------------------- duplicate subscriptions

test("clicking upgrade twice does not create two subscriptions", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);

  const first = await handleCreateSubscription(buyCtx(session), w);
  const second = await handleCreateSubscription(buyCtx(session), w);

  assert.equal(w.api.created.length, 1, `${w.api.created.length} subscriptions were created`);
  assert.equal(second.status, 200);
  assert.equal(second.body.subscriptionId, first.body.subscriptionId);
  assert.equal(second.body.resumed, true);
  assert.equal(second.body.activated, false);
});

test("concurrent double-clicks do not create two subscriptions", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);

  const results = await Promise.all([
    handleCreateSubscription(buyCtx(session), w),
    handleCreateSubscription(buyCtx(session), w),
    handleCreateSubscription(buyCtx(session), w),
  ]);

  for (const r of results) assert.equal(r.status, 200);
  const ids = new Set(results.map((r) => r.body.subscriptionId));
  assert.equal(ids.size, 1, "concurrent clicks produced different subscriptions");
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");
});

test("an already-active subscriber is refused a second one", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.owner);
  await handleCreateSubscription(buyCtx(session), w);
  await handleRazorpayWebhook(activationCtx(), w);

  const again = await handleCreateSubscription(buyCtx(session), w);
  assert.equal(again.status, 409);
  assert.equal(w.api.created.length, 1);
});
