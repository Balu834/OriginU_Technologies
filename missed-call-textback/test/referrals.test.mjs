/**
 * Referral codes: a marketer's ?ref= link -> cookie -> stamped on the
 * business created at onboarding -> counted in the referral report.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { createBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createBillingService } from "../lib/billing.mjs";
import { createSession, COOKIE_NAME } from "../lib/auth.mjs";
import { generateEncryptionKey } from "../lib/crypto.mjs";
import {
  normalizeRefCode, referralCookieFor, referralFromRequest, REF_COOKIE,
  referralState, monthlyPayouts, monthlyBonusFor, monthOf, REFERRAL_RULES,
} from "../lib/referrals.mjs";
import { handleSignupGet, handleOnboardingPost } from "../routes/accounts.mjs";
import { handleLanding } from "../routes/dashboard.mjs";
import { referralRows } from "../scripts/referral-report.mjs";
import { createFakeWa, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const KEY = generateEncryptionKey();
const form = (f) => Buffer.from(new URLSearchParams(f).toString());
const cookiesOut = (res) => [res.headers?.["Set-Cookie"] ?? []].flat();

function deps(store = createStore(null)) {
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: KEY };
  return {
    store, config, templates, wa: createFakeWa(),
    accounts: createAccountService(store),
    integrations: createIntegrationService(store, config),
    businesses: createBusinessRegistry([]),
  };
}

async function onboard(d, email, refCookie) {
  const user = await d.accounts.signUp({ email, password: "a-long-enough-password" });
  const sid = await createSession(d.store, null, { userId: user.id });
  const cookie = [`${COOKIE_NAME}=${sid}`, refCookie ? `${REF_COOKIE}=${refCookie}` : ""].filter(Boolean).join("; ");
  const res = await handleOnboardingPost(
    { headers: { cookie }, rawBody: form({ name: `${email} Biz`, ownerName: "Ravi", ownerWhatsApp: "+919876543210", referralCode: "typed-in" }) },
    d
  );
  const [membership] = await d.accounts.membershipsOf(user.id);
  return { res, business: await d.store.getBusiness(membership.businessId) };
}

test("codes are cleaned and anything odd is ignored", () => {
  assert.equal(normalizeRefCode(" Ravi "), "ravi");
  assert.equal(normalizeRefCode("team_a-1"), "team_a-1");
  assert.equal(normalizeRefCode("x"), "");
  assert.equal(normalizeRefCode("<script>"), "");
  assert.equal(normalizeRefCode("a".repeat(33)), "");
});

test("opening /signup?ref= or /?ref= remembers the code for 30 days", () => {
  const signup = handleSignupGet({ query: new URLSearchParams("ref=Ravi"), headers: {} }, deps());
  const [cookie] = cookiesOut(signup);
  assert.match(cookie, /^mc_ref=ravi;/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);

  const landing = handleLanding({ query: new URLSearchParams("ref=ravi"), headers: {} });
  assert.match(cookiesOut(landing)[0], /^mc_ref=ravi;/);
  assert.equal(landing.status, 200);
});

test("first link wins, and a bad code sets nothing", () => {
  const already = { query: new URLSearchParams("ref=suresh"), headers: { cookie: `${REF_COOKIE}=ravi` } };
  assert.equal(referralCookieFor(already), null);
  assert.equal(referralFromRequest(already), "ravi");
  assert.equal(referralCookieFor({ query: new URLSearchParams("ref=%3Cx%3E"), headers: {} }), null);
  assert.deepEqual(cookiesOut(handleSignupGet({ query: new URLSearchParams(), headers: {} }, deps())), []);
});

test("onboarding stamps the code on the new business and clears it", async () => {
  const d = deps();
  const { res, business } = await onboard(d, "ref@example.test", "ravi");
  assert.equal(business.referralCode, "ravi");
  assert.ok(cookiesOut(res).some((c) => /^mc_ref=;.*Max-Age=0/.test(c)), "code cookie cleared");
  assert.ok(cookiesOut(res).some((c) => c.startsWith(`${COOKIE_NAME}=`)), "session cookie still set");
});

test("without a link, or with only a form field, there is no code", async () => {
  const d = deps();
  const { res, business } = await onboard(d, "plain@example.test", null);
  assert.equal(business.referralCode, "", "a typed-in form value is ignored");
  assert.equal(cookiesOut(res).length, 1);
});

// ---------------------------------------------------------------- payout rules

const DAY = 24 * 60 * 60 * 1000;
const at = (iso, plusDays = 0) => new Date(Date.parse(iso) + plusDays * DAY).toISOString();

test("a connect is verified only by a first lead within 14 days", () => {
  const connectedAt = "2026-11-02T06:00:00Z";
  const now = Date.parse(at(connectedAt, 30));
  assert.equal(referralState({ connected: false }, now).state, "not connected");
  assert.equal(referralState({ connected: true, connectedAt, firstLeadAt: at(connectedAt, 3) }, now).state, "verified");
  assert.equal(referralState({ connected: true, connectedAt, firstLeadAt: at(connectedAt, 14) }, now).state, "verified", "day 14 still counts");
  assert.equal(referralState({ connected: true, connectedAt, firstLeadAt: at(connectedAt, 15) }, now).state, "no lead in time");
  assert.equal(referralState({ connected: true, connectedAt, firstLeadAt: null }, now).state, "no lead in time");
  assert.equal(referralState({ connected: true, connectedAt, firstLeadAt: null }, Date.parse(at(connectedAt, 5))).state, "waiting for first lead");
});

test("bonus steps: highest reached only", () => {
  assert.equal(monthlyBonusFor(49), 0);
  assert.equal(monthlyBonusFor(50), 1000);
  assert.equal(monthlyBonusFor(149), 1000);
  assert.equal(monthlyBonusFor(150), 2500);
  assert.equal(monthlyBonusFor(300), 5000);
  assert.equal(monthlyBonusFor(1000), 5000);
});

test("months are counted in India time", () => {
  assert.equal(monthOf("2026-11-30T19:00:00Z"), "2026-12", "00:30 IST on 1 Dec");
  assert.equal(monthOf("2026-11-30T18:00:00Z"), "2026-11");
});

test("monthly payout: Rs 100 per verified connect, paying bonus, step bonus", () => {
  const nov = "2026-11-05T06:00:00Z";
  const now = Date.parse("2026-12-20T06:00:00Z");
  const row = (code, extra) => ({ code, business: { id: code + Math.random(), name: "b" }, connected: true, connectedAt: nov, leads: 1, ...extra });

  const rows = [
    // ravi: 50 verified in November -> 50 x 100 + 1,000 bonus, one starts paying in Nov -> +200
    ...Array.from({ length: 50 }, () => row("ravi", { firstLeadAt: at(nov, 1) })),
    row("ravi", { firstLeadAt: at(nov, 2), paying: true, payingSince: at(nov, 10) }),
    row("ravi", { firstLeadAt: null, leads: 0 }),                       // no lead in time: nothing
    row("ravi", { connected: false, connectedAt: null, leads: 0 }),     // only signed up: nothing
    // suresh: verified in December, so nothing for November
    row("suresh", { connectedAt: "2026-11-28T06:00:00Z", firstLeadAt: "2026-12-02T06:00:00Z" }),
  ];

  const [ravi, suresh] = monthlyPayouts(rows, "2026-11", { now });
  assert.equal(ravi.code, "ravi");
  assert.equal(ravi.verified, 51);
  assert.equal(ravi.expired, 1);
  assert.equal(ravi.base, 51 * REFERRAL_RULES.perVerifiedConnect);
  assert.equal(ravi.bonus, 1000);
  assert.equal(ravi.payingBonus, 200);
  assert.equal(ravi.total, 5100 + 1000 + 200);

  assert.equal(suresh.verified, 0);
  assert.equal(suresh.total, 0);
  const [, sureshDec] = monthlyPayouts(rows, "2026-12", { now }).sort((a, b) => a.code.localeCompare(b.code));
  assert.equal(sureshDec.total, 100, "paid in December, when it was verified");
});

test("the report reads connection, first lead and paying from the store", async () => {
  const store = createStore(null);
  const billing = createBillingService(store);
  const integrations = createIntegrationService(store, { INTEGRATION_ENCRYPTION_KEY: KEY });
  await store.saveBusiness(businessRecord({ id: "a1", name: "A1", referralCode: "ravi" }));
  await store.saveBusiness(businessRecord({ id: "a2", name: "A2", referralCode: "Ravi" }));
  await store.saveBusiness(businessRecord({ id: "c1", name: "C1" }));

  await integrations.registerQr({ businessId: "a2", phone: "+919000000001" });
  await scopedToBusiness(store, "a2").saveLead({ id: "L1", callerNumber: "+917000000001", createdAt: new Date().toISOString() });
  await billing.changePlan({ businessId: "a2", plan: "PRO", status: "ACTIVE", reason: "test" });

  const rows = await referralRows(store);
  assert.equal(rows.length, 2, "a business with no code is not counted");
  const a2 = rows.find((r) => r.business.id === "a2");
  assert.equal(a2.code, "ravi");
  assert.equal(a2.connected, true);
  assert.ok(a2.connectedAt && a2.firstLeadAt);
  assert.equal(a2.paying, true);

  const [ravi] = monthlyPayouts(rows, monthOf(Date.now()));
  assert.equal(ravi.verified, 1);
  assert.equal(ravi.total, 100 + 200);
});
