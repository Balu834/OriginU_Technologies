/**
 * Razorpay checkout and webhook security.
 *
 * The property under test throughout is one sentence: a business becomes
 * paid because a correctly signed webhook said so, and for no other
 * reason. Everything else here is an attempt to make that untrue.
 *
 * Razorpay is mocked at fetch; no live credentials are used and no real
 * payment is made. Assertions are against stored subscription records,
 * not markup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService, PLAN_ENTITLEMENTS } from "../lib/billing.mjs";
import { createUsageService } from "../lib/usage.mjs";
import {
  verifyWebhookSignature, mapSubscriptionStatus, createRazorpayClient,
  publicConfig, isHandledEvent, HANDLED_EVENTS, isoFromUnix,
} from "../lib/razorpay.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleRazorpayWebhook } from "../routes/razorpayWebhook.mjs";
import { handleCreateSubscription } from "../routes/billingCheckout.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const WEBHOOK_SECRET = "FAKE-RAZORPAY-WEBHOOK-SECRET";
const KEY_SECRET = "FAKE-RAZORPAY-KEY-SECRET";
const KEY_ID = "rzp_test_FAKEKEYID";
const PRO_PLAN_ID = "plan_FAKEPRO123";

const SUB_A = "sub_AAAAAAAAAAAA";
const SUB_B = "sub_BBBBBBBBBBBB";

const RZP = {
  keyId: KEY_ID,
  keySecret: KEY_SECRET,
  webhookSecret: WEBHOOK_SECRET,
  planIds: { PRO: PRO_PLAN_ID, BUSINESS: "" },
};

/** Mocks Razorpay's subscription-create endpoint. */
function mockRazorpayApi({ fail = false, id = SUB_A } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), auth: options.headers?.Authorization ?? "", body: JSON.parse(options.body ?? "{}") });
    if (fail) return { ok: false, status: 400, json: async () => ({ error: { code: "BAD_REQUEST_ERROR", description: "nope" } }) };
    return { ok: true, status: 200, json: async () => ({ id, status: "created", plan_id: options.body ? JSON.parse(options.body).plan_id : null }) };
  };
  return { calls, fetchImpl };
}

async function buildWorld({ razorpay = RZP, api = mockRazorpayApi() } = {}) {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "d".repeat(64), DASHBOARD_PASSWORD_HASH: hashPassword("pw-x") };
  const accounts = createAccountService(store);
  const billing = createBillingService(store);
  const usage = createUsageService(store);

  const userA = await accounts.signUp({ email: "rzp-a@example.test", password: "rzp-a-password" });
  const userB = await accounts.signUp({ email: "rzp-b@example.test", password: "rzp-b-password" });
  const bizA = businessRecord({ id: "rzp-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: "+911", services: ["x"] });
  const bizB = businessRecord({ id: "rzp-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: "+912", services: ["y"] });
  await accounts.createBusinessFor(userA, bizA);
  await accounts.createBusinessFor(userB, bizB);

  const businesses = await loadBusinessRegistry(store, config);
  return {
    store, config, accounts, billing, usage, businesses, templates, wa: createFakeWa(),
    razorpay, razorpayClient: createRazorpayClient(razorpay, { fetchImpl: api.fetchImpl }),
    api, userA, userB, bizA, bizB,
  };
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

const sign = (raw, secret = WEBHOOK_SECRET) =>
  crypto.createHmac("sha256", secret).update(raw).digest("hex");

function webhookCtx(payload, { secret = WEBHOOK_SECRET, signature, raw } = {}) {
  const rawBody = raw ?? Buffer.from(JSON.stringify(payload));
  return {
    method: "POST", pathname: "/razorpay-webhook",
    headers: { "x-razorpay-signature": signature ?? sign(rawBody, secret) },
    rawBody,
  };
}

const NOW = 1790000000;
function subscriptionEvent({
  event = "subscription.activated", id = SUB_A, status = "active",
  currentStart = NOW, currentEnd = NOW + 2592000, eventId = null, notes = {},
} = {}) {
  return {
    entity: "event",
    id: eventId ?? `evt_${event}_${id}_${currentStart}`,
    event,
    payload: {
      subscription: {
        entity: { id, status, current_start: currentStart, current_end: currentEnd, customer_id: "cust_FAKE", notes },
      },
    },
  };
}

const checkoutCtx = (session, body = {}) => ({
  method: "POST", pathname: "/billing/create-subscription",
  query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
  rawBody: Buffer.from(JSON.stringify(body)),
});

// ============================================ signature verification

test("a valid signature is accepted and an invalid one is not", () => {
  const raw = Buffer.from('{"event":"subscription.activated"}');
  assert.equal(verifyWebhookSignature(raw, sign(raw), WEBHOOK_SECRET), true);
  assert.equal(verifyWebhookSignature(raw, sign(raw, "other-secret"), WEBHOOK_SECRET), false);
  assert.equal(verifyWebhookSignature(raw, "", WEBHOOK_SECRET), false);
  assert.equal(verifyWebhookSignature(raw, sign(raw), ""), false);
  // A different body under the same secret must not verify.
  assert.equal(verifyWebhookSignature(Buffer.from('{"event":"x"}'), sign(raw), WEBHOOK_SECRET), false);
  // A short/long signature must be rejected, not throw.
  assert.equal(verifyWebhookSignature(raw, "abc", WEBHOOK_SECRET), false);
});

test("an invalid signature is rejected with 403 and changes nothing", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);

  const payload = subscriptionEvent();
  const res = await handleRazorpayWebhook(
    webhookCtx(payload, { signature: sign(Buffer.from(JSON.stringify(payload)), "wrong-secret") }), w);

  assert.equal(res.status, 403);
  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "FREE");
});

test("a missing signature header is rejected", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  const rawBody = Buffer.from(JSON.stringify(subscriptionEvent()));

  const res = await handleRazorpayWebhook({ method: "POST", headers: {}, rawBody }, w);
  assert.equal(res.status, 403);
  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "FREE");
});

test("a malformed payload with a valid signature is rejected safely", async () => {
  const w = await buildWorld();
  const rawBody = Buffer.from("{not json at all");
  const res = await handleRazorpayWebhook(webhookCtx(null, { raw: rawBody }), w);
  assert.equal(res.status, 400);
});

test("with no webhook secret configured the endpoint refuses rather than trusts", async () => {
  const w = await buildWorld({ razorpay: { ...RZP, webhookSecret: "" } });
  const res = await handleRazorpayWebhook(webhookCtx(subscriptionEvent()), w);
  assert.equal(res.status, 503);
});

// ==================================================== tenant resolution

test("a verified webhook updates the business the stored index names", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  const res = await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ event: "subscription.activated", status: "active" })), w);
  assert.equal(res.status, 200);
  assert.equal(res.body.handled, true);

  const sub = await w.billing.forBusiness(w.bizA.id);
  assert.equal(sub.plan, "PRO");
  assert.equal(sub.status, "ACTIVE");
  assert.equal(sub.provider, "razorpay");
  assert.equal(sub.providerSubscriptionId, SUB_A);

  const ent = await w.billing.getBusinessEntitlements(w.bizA.id);
  assert.equal(ent.plan, "PRO");
  assert.equal(ent.limits.leadsPerMonth, PLAN_ENTITLEMENTS.PRO.leadsPerMonth);

  // And business B is untouched.
  assert.equal((await w.billing.forBusiness(w.bizB.id)).plan, "FREE");
});

test("notes.businessId cannot redirect the update to another tenant", async () => {
  const w = await buildWorld();
  // The index says SUB_A belongs to A. The payload claims B.
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  const res = await handleRazorpayWebhook(
    webhookCtx(subscriptionEvent({ notes: { businessId: w.bizB.id } })), w);
  assert.equal(res.status, 200);

  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "PRO", "the real owner was not updated");
  assert.equal((await w.billing.forBusiness(w.bizB.id)).plan, "FREE", "notes redirected the payment to another tenant");
});

test("an unknown subscription id mutates nothing and does not fall back to a default", async () => {
  const w = await buildWorld();
  const res = await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ id: "sub_NEVER_SEEN" })), w);

  assert.equal(res.status, 200);
  assert.equal(res.body.handled, false);
  for (const id of ["default", w.bizA.id, w.bizB.id]) {
    const sub = await w.billing.forBusiness(id);
    assert.equal(sub.plan, "FREE", `unknown subscription changed ${id}`);
    assert.equal(sub.implicit, true, `unknown subscription wrote a record for ${id}`);
  }
});

test("business A's webhook cannot modify business B", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.store.saveProviderSubscription(SUB_B, w.bizB.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });
  await w.billing.beginCheckout({ businessId: w.bizB.id, plan: "PRO", providerSubscriptionId: SUB_B });

  await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ id: SUB_A, status: "active" })), w);
  await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ id: SUB_B, status: "cancelled", event: "subscription.cancelled" })), w);

  assert.equal((await w.billing.forBusiness(w.bizA.id)).status, "ACTIVE");
  assert.equal((await w.billing.forBusiness(w.bizB.id)).status, "CANCELED");
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "PRO");
  assert.equal((await w.billing.getBusinessEntitlements(w.bizB.id)).plan, "FREE", "a cancelled sub kept PRO limits");
});

// ======================================================= idempotency

test("the same event delivered twice is applied once", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  const payload = subscriptionEvent({ event: "subscription.charged", status: "active", eventId: "evt_ONCE" });

  const first = await handleRazorpayWebhook(webhookCtx(payload), w);
  assert.equal(first.body.handled, true);
  const after = await w.billing.forBusiness(w.bizA.id);

  const second = await handleRazorpayWebhook(webhookCtx(payload), w);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.deepEqual(await w.billing.forBusiness(w.bizA.id), after, "a replay changed stored state");
});

test("a replayed subscription.charged does not extend the period twice", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  const charge = subscriptionEvent({ event: "subscription.charged", status: "active", eventId: "evt_CHARGE_1" });
  await handleRazorpayWebhook(webhookCtx(charge), w);
  const afterFirst = await w.billing.forBusiness(w.bizA.id);
  assert.equal(afterFirst.currentPeriodEnd, isoFromUnix(NOW + 2592000));

  await handleRazorpayWebhook(webhookCtx(charge), w);
  const afterReplay = await w.billing.forBusiness(w.bizA.id);
  assert.equal(afterReplay.currentPeriodEnd, afterFirst.currentPeriodEnd, "the period moved on a replay");

  // A genuine NEXT charge, with a new period and a new event id, does advance it.
  const nextStart = NOW + 2592000;
  const next = subscriptionEvent({
    event: "subscription.charged", status: "active", eventId: "evt_CHARGE_2",
    currentStart: nextStart, currentEnd: nextStart + 2592000,
  });
  await handleRazorpayWebhook(webhookCtx(next), w);
  assert.equal((await w.billing.forBusiness(w.bizA.id)).currentPeriodEnd, isoFromUnix(nextStart + 2592000));
});

test("concurrent duplicate deliveries are applied once", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  const payload = subscriptionEvent({ event: "subscription.charged", eventId: "evt_CONCURRENT" });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => handleRazorpayWebhook(webhookCtx(payload), w))
  );

  const applied = results.filter((r) => r.body?.handled === true);
  assert.equal(applied.length, 1, `${applied.length} concurrent deliveries were applied`);
});

test("an id-less payload still cannot be replayed", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  const payload = subscriptionEvent({ event: "subscription.charged" });
  delete payload.id;

  assert.equal((await handleRazorpayWebhook(webhookCtx(payload), w)).body.handled, true);
  assert.equal((await handleRazorpayWebhook(webhookCtx(payload), w)).body.duplicate, true);
});

// ================================================== state mapping

test("razorpay statuses map to the audited meanings", () => {
  assert.deepEqual(
    ["authenticated", "active", "pending", "halted", "paused", "cancelled", "completed"].map(mapSubscriptionStatus),
    ["TRIALING", "ACTIVE", "PAST_DUE", "PAST_DUE", "PAST_DUE", "CANCELED", "EXPIRED"]
  );
  // Unknown and not-yet-paid states are not guessed at.
  assert.equal(mapSubscriptionStatus("created"), null);
  assert.equal(mapSubscriptionStatus("something_new"), null);
  assert.equal(mapSubscriptionStatus(undefined), null);
});

test("each mapped status produces the right entitlement", async () => {
  const cases = [
    ["subscription.authenticated", "authenticated", "TRIALING", "PRO"],
    ["subscription.activated", "active", "ACTIVE", "PRO"],
    ["subscription.pending", "pending", "PAST_DUE", "FREE"],
    ["subscription.halted", "halted", "PAST_DUE", "FREE"],
    ["subscription.paused", "paused", "PAST_DUE", "FREE"],
    ["subscription.cancelled", "cancelled", "CANCELED", "FREE"],
    ["subscription.completed", "completed", "EXPIRED", "FREE"],
  ];

  for (const [event, rzpStatus, ourStatus, entitled] of cases) {
    const w = await buildWorld();
    await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
    await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

    await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ event, status: rzpStatus })), w);
    const sub = await w.billing.forBusiness(w.bizA.id);
    assert.equal(sub.status, ourStatus, `${event} stored the wrong status`);
    assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, entitled, `${event} gave the wrong entitlement`);
  }
});

test("an unmapped or unhandled event changes nothing", async () => {
  const w = await buildWorld();
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await w.billing.beginCheckout({ businessId: w.bizA.id, plan: "PRO", providerSubscriptionId: SUB_A });

  // subscription.updated is intentionally not handled.
  assert.equal(isHandledEvent("subscription.updated"), false);
  assert.equal(isHandledEvent("subscription.created"), false);
  const ignored = await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ event: "subscription.updated" })), w);
  assert.equal(ignored.body.handled, false);

  // A handled event carrying a status we do not understand is also refused.
  const unmapped = await handleRazorpayWebhook(
    webhookCtx(subscriptionEvent({ event: "subscription.activated", status: "quantum" })), w);
  assert.equal(unmapped.body.handled, false);

  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "FREE");
});

test("only subscription.charged advances the billing period", () => {
  const advancing = Object.entries(HANDLED_EVENTS).filter(([, v]) => v.advancesPeriod).map(([k]) => k);
  assert.deepEqual(advancing, ["subscription.charged"]);
});

// ===================================================== checkout route

test("checkout requires a session, a business and the right role", async () => {
  const w = await buildWorld();
  assert.equal((await handleCreateSubscription(checkoutCtx(null), w)).status, 401);

  const stranger = await w.accounts.signUp({ email: "rzp-none@example.test", password: "rzp-none-password" });
  const noBiz = await createSession(w.store, null, { userId: stranger.id });
  assert.equal((await handleCreateSubscription(checkoutCtx(noBiz), w)).status, 403);

  await w.accounts.addMember({ businessId: w.bizA.id, email: "rzp-none@example.test", role: "STAFF" });
  const staff = await createSession(w.store, w.bizA.id, { userId: stranger.id });
  const res = await handleCreateSubscription(checkoutCtx(staff), w);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /role/);
});

test("checkout creates a subscription but grants nothing", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await handleCreateSubscription(checkoutCtx(session, { plan: "PRO" }), w);
  assert.equal(res.status, 200);
  assert.equal(res.body.subscriptionId, SUB_A);
  assert.equal(res.body.activated, false, "checkout claimed activation");
  assert.equal(res.body.keyId, KEY_ID);

  // Intent recorded, plan unchanged, entitlement unchanged.
  const sub = await w.billing.forBusiness(w.bizA.id);
  assert.equal(sub.pendingPlan, "PRO");
  assert.equal(sub.plan, "FREE", "opening checkout granted the plan");
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");

  // The authoritative index was written.
  assert.equal(await w.store.getBusinessByProviderSubscription(SUB_A), w.bizA.id);

  // Razorpay was asked for the SERVER's plan id.
  assert.equal(w.api.calls[0].body.plan_id, PRO_PLAN_ID);
});

test("the browser cannot choose a razorpay plan id or an arbitrary plan", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  // A provider plan id in the body is ignored entirely.
  await handleCreateSubscription(checkoutCtx(session, { plan: "PRO", plan_id: "plan_ATTACKER", planId: "plan_ATTACKER" }), w);
  assert.equal(w.api.calls[0].body.plan_id, PRO_PLAN_ID, "the client chose the razorpay plan id");

  // Non-purchasable plans are refused.
  for (const plan of ["FREE", "BUSINESS", "ENTERPRISE", ""]) {
    const res = await handleCreateSubscription(checkoutCtx(await sessionFor(w, w.userB), { plan }), w);
    if (plan === "") continue; // empty falls back to the default PRO
    assert.equal(res.status, 400, `${plan} was purchasable`);
  }
});

test("a businessId in the checkout body cannot redirect the subscription", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  await handleCreateSubscription(checkoutCtx(session, { plan: "PRO", businessId: w.bizB.id }), w);

  assert.equal(await w.store.getBusinessByProviderSubscription(SUB_A), w.bizA.id);
  assert.equal((await w.billing.forBusiness(w.bizB.id)).implicit, true, "a body businessId created a record for another tenant");
});

test("a second checkout is refused once a subscription is live", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  await handleCreateSubscription(checkoutCtx(session, { plan: "PRO" }), w);
  await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
  await handleRazorpayWebhook(webhookCtx(subscriptionEvent({ status: "active" })), w);

  const second = await handleCreateSubscription(checkoutCtx(session, { plan: "PRO" }), w);
  assert.equal(second.status, 409);
});

test("checkout refuses when the provider or the price is not configured", async () => {
  for (const rzp of [
    { ...RZP, keyId: "", keySecret: "" },
    { ...RZP, planIds: { PRO: "", BUSINESS: "" } },
  ]) {
    const w = await buildWorld({ razorpay: rzp });
    const session = await sessionFor(w, w.userA);
    const res = await handleCreateSubscription(checkoutCtx(session, { plan: "PRO" }), w);
    assert.equal(res.status, 503);
    assert.equal((await w.billing.forBusiness(w.bizA.id)).implicit, true);
  }
});

test("a provider failure does not record intent or grant anything", async () => {
  const w = await buildWorld({ api: mockRazorpayApi({ fail: true }) });
  const session = await sessionFor(w, w.userA);

  const res = await handleCreateSubscription(checkoutCtx(session, { plan: "PRO" }), w);
  assert.equal(res.status, 502);
  assert.equal((await w.billing.forBusiness(w.bizA.id)).implicit, true);
  assert.equal(await w.store.getBusinessByProviderSubscription(SUB_A), null);
});

// ======================================================== secrets

test("no secret appears in any response or log line", async () => {
  const w = await buildWorld();
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));

  const bodies = [];
  try {
    const session = await sessionFor(w, w.userA);
    bodies.push(JSON.stringify(await handleCreateSubscription(checkoutCtx(session, { plan: "PRO" }), w)));
    await w.store.saveProviderSubscription(SUB_A, w.bizA.id);
    bodies.push(JSON.stringify(await handleRazorpayWebhook(webhookCtx(subscriptionEvent()), w)));
    bodies.push(JSON.stringify(await handleRazorpayWebhook(webhookCtx(subscriptionEvent(), { signature: "deadbeef" }), w)));
  } finally {
    console.log = log;
    console.error = error;
  }

  const all = bodies.join("\n") + "\n" + lines.join("\n");
  for (const secret of [WEBHOOK_SECRET, KEY_SECRET]) {
    assert.ok(!all.includes(secret), "a secret reached a response or a log line");
  }
  // The public key id is allowed out — Razorpay's widget requires it.
  assert.ok(bodies.join("\n").includes(KEY_ID));
  assert.deepEqual(publicConfig(RZP), { keyId: KEY_ID, configured: true });
  assert.ok(!JSON.stringify(publicConfig(RZP)).includes(KEY_SECRET));
});

test("the razorpay client sends basic auth and never returns the secret", async () => {
  const api = mockRazorpayApi();
  const client = createRazorpayClient(RZP, { fetchImpl: api.fetchImpl });
  const res = await client.createSubscription({ planId: PRO_PLAN_ID, notes: { businessId: "x" } });

  assert.equal(res.ok, true);
  assert.ok(api.calls[0].auth.startsWith("Basic "));
  const decoded = Buffer.from(api.calls[0].auth.slice(6), "base64").toString();
  assert.equal(decoded, `${KEY_ID}:${KEY_SECRET}`);
  assert.ok(!JSON.stringify(res).includes(KEY_SECRET));
});

// ================================================ changePlan authority

test("no browser-reachable route can set a plan directly", async () => {
  const { dispatch } = await import("../routes/router.mjs");
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  for (const path of ["/settings/billing", "/billing/change-plan", "/billing/upgrade"]) {
    const res = await dispatch({
      method: "POST", pathname: path, query: new URLSearchParams(),
      headers: { cookie: `${COOKIE_NAME}=${session}` },
      rawBody: Buffer.from("plan=PRO&status=ACTIVE"),
    }, w);
    // Either unroutable, or routed to checkout which grants nothing.
    if (res) assert.notEqual(res.status, 200);
  }
  assert.equal((await w.billing.forBusiness(w.bizA.id)).plan, "FREE");
});

test("the checkout route is the only browser POST in the billing area, and it cannot grant", async () => {
  const { dispatch } = await import("../routes/router.mjs");
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await dispatch({
    method: "POST", pathname: "/billing/create-subscription", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${session}` },
    rawBody: Buffer.from(JSON.stringify({ plan: "PRO", status: "ACTIVE", businessId: w.bizB.id })),
  }, w);

  assert.equal(res.status, 200);
  assert.equal(res.body.activated, false);
  assert.equal((await w.billing.getBusinessEntitlements(w.bizA.id)).plan, "FREE");
  assert.equal((await w.billing.getBusinessEntitlements(w.bizB.id)).plan, "FREE");
});
