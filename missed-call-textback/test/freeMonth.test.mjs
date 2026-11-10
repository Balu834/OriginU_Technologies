/**
 * Free is a first-month trial, and its 25 leads are a real limit.
 *
 * Pinned here: when the month starts and ends, that a business past it
 * starts no new conversations (and nothing half-done is left behind),
 * that the 25 leads cannot be doubled by a month that crosses the 1st,
 * and that paying restores replies with no code change.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService, freeTrialWindow, FREE_TRIAL, PLAN_ENTITLEMENTS } from "../lib/billing.mjs";
import { createUsageService } from "../lib/usage.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { hashPassword } from "../lib/auth.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { landingPage } from "../lib/landing.mjs";
import { termsPage } from "../lib/legalViews.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const DAY = 24 * 60 * 60 * 1000;
const API_KEY = "free-month-missed-call-key";

/** A world whose billing and usage read the same movable clock. */
async function buildWorld({ createdAt, now }) {
  const clock = { now: new Date(now) };
  const tick = () => new Date(clock.now);
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "d".repeat(64), DASHBOARD_PASSWORD_HASH: hashPassword("pw-free-month") };
  const accounts = createAccountService(store);
  const integrations = createIntegrationService(store, config);
  const billing = createBillingService(store, { clock: tick });
  const usage = createUsageService(store, { clock: tick });

  const user = await accounts.signUp({ email: "free-month@example.test", password: "free-month-password" });
  const biz = businessRecord({
    id: "free-month-biz", name: "Gamma AC Service", ownerName: "Gita", ownerWhatsApp: "+913333333333",
    services: ["AC repair"], missedCallApiKey: API_KEY,
    missedCallTemplate: "missed_call_immediate", templateLanguage: "en",
    createdAt,
  });
  await accounts.createBusinessFor(user, biz);
  await integrations.register({ businessId: biz.id, phoneNumberId: "PHONE_FREE_MONTH", wabaId: "WABA_FM", accessToken: "FAKE-FM" });
  const businesses = await loadBusinessRegistry(store, config);
  return { clock, store, config, accounts, integrations, billing, usage, businesses, wa: createFakeWa(), templates, biz };
}

const missedCallCtx = (caller = "+919000000777") => ({
  method: "POST", pathname: "/missed-call", query: new URLSearchParams(),
  headers: { authorization: `Bearer ${API_KEY}` },
  rawBody: Buffer.alloc(0),
  json: { callerNumber: caller },
});

async function call(w, caller) {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ messaging_product: "whatsapp", messages: [{ id: `wamid.FM${++n}` }] }) });
  try {
    return await handleMissedCall(missedCallCtx(caller), w);
  } finally {
    globalThis.fetch = original;
  }
}

// ------------------------------------------------------ the window itself

test("the free month runs 30 days from sign-up", () => {
  const w = freeTrialWindow("2026-12-01T10:00:00.000Z");
  assert.equal(w.days, 30);
  assert.equal(w.startedAt, "2026-12-01T10:00:00.000Z");
  assert.equal(Date.parse(w.endsAt) - Date.parse(w.startedAt), 30 * DAY);
});

test("businesses that signed up before launch get their month from launch, not from their old date", () => {
  const launch = new Date(Date.parse(FREE_TRIAL.launch)).toISOString();
  assert.equal(freeTrialWindow("2026-09-01T00:00:00.000Z").startedAt, launch);
  assert.equal(freeTrialWindow(null).startedAt, launch, "a business with no sign-up date starts at launch");
  assert.equal(freeTrialWindow("not a date").startedAt, launch);
});

// ------------------------------------------------------- entitlements

test("a new FREE business is inside its free month", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2026-12-05T10:00:00.000Z" });
  const ent = await w.billing.getBusinessEntitlements(w.biz.id);
  assert.equal(ent.plan, "FREE");
  assert.equal(ent.freeTrial.ended, false);
  assert.equal(ent.freeTrial.startedAt, "2026-12-01T10:00:00.000Z");
  assert.deepEqual(ent.limits, PLAN_ENTITLEMENTS.FREE);
});

test("after 30 days the free month has ended", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2026-12-31T10:00:00.000Z" });
  assert.equal((await w.billing.getBusinessEntitlements(w.biz.id)).freeTrial.ended, true);
});

test("a paid plan has no free month to run out", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2027-03-01T10:00:00.000Z" });
  await w.billing.changePlan({ businessId: w.biz.id, plan: "PRO", reason: "test" });
  assert.equal((await w.billing.getBusinessEntitlements(w.biz.id)).freeTrial, null);
});

test("a lapsed PRO falls back to FREE and does not get a second free month", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2027-03-01T10:00:00.000Z" });
  await w.billing.changePlan({ businessId: w.biz.id, plan: "PRO", status: "CANCELED", reason: "test" });
  const ent = await w.billing.getBusinessEntitlements(w.biz.id);
  assert.equal(ent.plan, "FREE");
  assert.equal(ent.freeTrial.ended, true);
});

// ------------------------------------------------- enforcement at the gate

test("inside the free month a missed call is answered", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2026-12-10T10:00:00.000Z" });
  const res = await call(w);
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
});

test("after the free month no new conversation starts, and nothing half-done is left", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2027-01-02T10:00:00.000Z" });
  const res = await call(w, "+919000000778");

  assert.equal(res.status, 402);
  assert.equal(res.body.sent, false);
  assert.equal(res.body.reason, "free_month_ended");
  assert.equal(res.body.plan, "FREE");
  assert.equal(await w.usage.count(w.biz.id, "messages"), 0, "a refused call was billed");

  const scoped = (await import("../lib/store.redis.mjs")).scopedToBusiness(w.store, w.biz.id);
  assert.equal(await scoped.lastMissedCallAt("+919000000778"), null, "a dedupe marker would block the retry after upgrading");
});

test("paying restores replies after the free month with no code change", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2027-01-02T10:00:00.000Z" });
  assert.equal((await call(w)).status, 402);
  await w.billing.changePlan({ businessId: w.biz.id, plan: "PRO", reason: "test" });
  assert.equal((await call(w)).status, 200);
});

test("the 25-lead limit is enforced, not only counted", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2026-12-10T10:00:00.000Z" });
  await w.usage.record(w.biz.id, "leads", PLAN_ENTITLEMENTS.FREE.leadsPerMonth);

  const res = await call(w, "+919000000779");
  assert.equal(res.status, 402);
  assert.equal(res.body.reason, "lead_limit");
  assert.equal(res.body.used, 25);
  assert.equal(res.body.limit, 25);
  assert.equal(await w.usage.count(w.biz.id, "messages"), 0);
});

test("24 leads still leaves room for one more conversation", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2026-12-10T10:00:00.000Z" });
  await w.usage.record(w.biz.id, "leads", PLAN_ENTITLEMENTS.FREE.leadsPerMonth - 1);
  assert.equal((await call(w)).status, 200);
});

test("a free month that crosses the 1st does not reset to another 25 leads", async () => {
  const w = await buildWorld({ createdAt: "2026-12-20T10:00:00.000Z", now: "2026-12-28T10:00:00.000Z" });
  await w.usage.record(w.biz.id, "leads", 20); // December
  w.clock.now = new Date("2027-01-05T10:00:00.000Z");
  await w.usage.record(w.biz.id, "leads", 5); // January: 25 in the free month

  assert.equal(await w.usage.count(w.biz.id, "leads"), 5, "the calendar-month counter did reset");
  const res = await call(w, "+919000000780");
  assert.equal(res.status, 402, "the free month's 25 became 25 + 25");
  assert.equal(res.body.reason, "lead_limit");
  assert.equal(res.body.used, 25);
});

test("on PRO the lead limit is per calendar month and far above 25", async () => {
  const w = await buildWorld({ createdAt: "2026-12-01T10:00:00.000Z", now: "2027-02-10T10:00:00.000Z" });
  await w.billing.changePlan({ businessId: w.biz.id, plan: "PRO", reason: "test" });
  await w.usage.record(w.biz.id, "leads", 25);
  assert.equal((await call(w)).status, 200);
});

// ---------------------------------------------------- what we tell people

test("the website says free for the first month, never free every month", () => {
  const html = landingPage({ plans: {
    FREE: { price: "Free", leads: 25, messages: 250, trialDays: 30 },
    PRO: { price: "₹299 / month", leads: 500, messages: 5000 },
  } });
  assert.match(html, /Free for your first month, up to 25 leads/);
  assert.match(html, /Up to 25 leads in your first month/);
  assert.match(html, /It&#39;s free for your first month|It's free for your first month/);
  assert.doesNotMatch(html, /Free plan, 25 leads a month/);
  assert.doesNotMatch(html, /free plan covers up to 25 leads a month/i);
});

test("the terms describe the free first month", () => {
  const html = termsPage();
  assert.match(html, /free first month/i);
  assert.match(html, /30 days from when you sign up/);
});

test("the billing page says when the free month ends, and the leads used in it", async () => {
  const { billingPage } = await import("../lib/settingsViews.mjs");
  const html = billingPage({
    entitlements: { plan: "FREE", limits: PLAN_ENTITLEMENTS.FREE, freeTrial: { ended: false, startedAt: "2026-12-20T10:00:00.000Z", endsAt: "2027-01-19T10:00:00.000Z" } },
    usage: { counts: { leads: 5, messages: 9 } },
    freeMonthLeads: 25,
  });
  assert.match(html, /Free month: ends on 19 Jan 2027/);
  assert.match(html, /Leads used: 25 of 25/, "the calendar-month counter (5) was shown instead of the free month's");
});

test("the billing page says plainly when the free month has ended", async () => {
  const { billingPage } = await import("../lib/settingsViews.mjs");
  const html = billingPage({
    entitlements: { plan: "FREE", limits: PLAN_ENTITLEMENTS.FREE, freeTrial: { ended: true, startedAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-31T10:00:00.000Z" } },
    usage: { counts: { leads: 0, messages: 0 } },
  });
  assert.match(html, /Your free month ended on 31 Dec 2026/);
  assert.match(html, /not getting a WhatsApp reply/);
});
