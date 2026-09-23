/**
 * Editing a business after onboarding.
 *
 * Until this existed, `saveBusiness` was called from no route: the owner
 * WhatsApp number that every lead alert is sent to was write-once, so a
 * typo at signup meant permanently misdirected leads. These tests hold
 * the new surface to the same rules as every other settings route, and
 * pin the two things most likely to go quietly wrong — a form reaching a
 * field it should not, and an edit that saves but does not take effect.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService } from "../lib/billing.mjs";
import { createUsageService } from "../lib/usage.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import {
  loadBusinessRegistry, businessRecord, applyBusinessProfile, publicBusiness,
} from "../lib/businesses.mjs";
import { isValidE164, normalizePhone } from "../lib/phone.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleBusinessSettingsGet, handleBusinessSettingsPost } from "../routes/businessSettings.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const A_NUMBER = "+919111111111";
const B_NUMBER = "+919222222222";

async function buildWorld() {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "f".repeat(64), DASHBOARD_PASSWORD_HASH: hashPassword("pw-bs") };
  const accounts = createAccountService(store);

  const ownerA = await accounts.signUp({ email: "bs-a@example.test", password: "bs-a-password" });
  const ownerB = await accounts.signUp({ email: "bs-b@example.test", password: "bs-b-password" });

  const bizA = businessRecord({
    id: "bs-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: A_NUMBER,
    services: ["Electrical repair"], areas: ["Indiranagar"], timezone: "Asia/Kolkata",
    missedCallApiKey: "alpha-secret-key", passwordHash: hashPassword("alpha-dash-pw"),
    phoneNumberId: "PHONE_A", wabaId: "WABA_A",
  });
  const bizB = businessRecord({
    id: "bs-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: B_NUMBER,
    services: ["Plumbing"], missedCallApiKey: "beta-secret-key",
  });
  await accounts.createBusinessFor(ownerA, bizA);
  await accounts.createBusinessFor(ownerB, bizB);

  const deps = {
    store, config, accounts, templates, wa: createFakeWa(),
    billing: createBillingService(store), usage: createUsageService(store),
    integrations: createIntegrationService(store, config),
    businesses: await loadBusinessRegistry(store, config),
  };
  return { ...deps, ownerA, ownerB, bizA, bizB };
}

/** Rebuilds the registry, as a real request does — proves an edit survives a reload. */
async function reload(w) {
  w.businesses = await loadBusinessRegistry(w.store, w.config);
  return w;
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

async function sessionAs(w, businessId, role, email) {
  const user = await w.accounts.signUp({ email, password: "role-password-x" });
  await w.accounts.addMember({ businessId, email, role });
  return createSession(w.store, businessId, { userId: user.id });
}

const getCtx = (session, query = {}) => ({
  method: "GET", pathname: "/settings/business", query: new URLSearchParams(query),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {}, rawBody: Buffer.alloc(0),
});
const postCtx = (session, form = {}) => ({
  method: "POST", pathname: "/settings/business", query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
  rawBody: Buffer.from(new URLSearchParams(form).toString()),
});

const VALID = {
  name: "Alpha Electrical Ltd", ownerName: "Anita R", ownerWhatsApp: "+919888888888",
  industry: "Electrical", businessPhone: "+918000000000", timezone: "Asia/Kolkata",
  greeting: "Hi, thanks for calling", services: "AC repair, Wiring", areas: "Indiranagar, HSR",
};

// ------------------------------------------------------------- loading

test("the page loads the signed-in user's own business", async () => {
  const w = await buildWorld();
  const res = await handleBusinessSettingsGet(getCtx(await sessionFor(w, w.ownerA)), w);

  assert.equal(res.status, 200);
  assert.ok(res.html.includes('value="Alpha Electrical"'), "the form was not pre-populated");
  assert.ok(res.html.includes(`value="${A_NUMBER}"`), "the owner number was not pre-populated");
  assert.ok(!res.html.includes("Beta Plumbing"), "another tenant's business appeared");
});

test("the page never renders the dashboard password hash or the missed-call key", async () => {
  const w = await buildWorld();
  const res = await handleBusinessSettingsGet(getCtx(await sessionFor(w, w.ownerA)), w);

  assert.ok(!res.html.includes("alpha-secret-key"), "the missed-call API key was rendered");
  assert.ok(!res.html.includes(w.bizA.passwordHash), "the dashboard password hash was rendered");
  const view = publicBusiness(w.businesses.byId("bs-a"));
  for (const key of ["passwordHash", "missedCallApiKey", "phoneNumberId", "wabaId"]) {
    assert.ok(!(key in view), `publicBusiness exposed ${key}`);
  }
});

test("unauthenticated and business-less callers get nothing", async () => {
  const w = await buildWorld();
  assert.equal((await handleBusinessSettingsGet(getCtx(null), w)).headers.Location, "/leads");
  assert.equal((await handleBusinessSettingsPost(postCtx(null, VALID), w)).status, 401);

  const stranger = await w.accounts.signUp({ email: "bs-none@example.test", password: "bs-none-password" });
  const session = await createSession(w.store, null, { userId: stranger.id });
  assert.equal((await handleBusinessSettingsPost(postCtx(session, VALID), w)).status, 403);
});

// -------------------------------------------------------------- update

test("an owner can update their business, and it persists across a reload", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);

  const res = await handleBusinessSettingsPost(postCtx(session, VALID), w);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/settings/business?saved=1");

  await reload(w);
  const saved = w.businesses.byId("bs-a");
  assert.equal(saved.name, "Alpha Electrical Ltd");
  assert.equal(saved.ownerWhatsApp, "+919888888888");
  assert.deepEqual(saved.services, ["AC repair", "Wiring"]);
  assert.deepEqual(saved.areas, ["Indiranagar", "HSR"]);
  assert.equal(saved.greeting, "Hi, thanks for calling");
  assert.equal(saved.timezone, "Asia/Kolkata");
});

test("an update cannot reach identity, credentials or unrelated records", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);
  const before = w.businesses.byId("bs-a");

  await handleBusinessSettingsPost(postCtx(session, {
    ...VALID,
    // Mass-assignment attempt: every field a form must never reach.
    id: "bs-b", businessId: "bs-b", tenantId: "bs-b", ownerId: "someone-else",
    passwordHash: "injected", missedCallApiKey: "injected", phoneNumberId: "INJECTED",
    wabaId: "INJECTED", createdAt: "1999-01-01T00:00:00.000Z", plan: "PRO", status: "hijacked",
  }), w);

  await reload(w);
  const after = w.businesses.byId("bs-a");
  assert.equal(after.id, "bs-a");
  assert.equal(after.createdAt, before.createdAt, "createdAt was rewritten");
  assert.equal(after.passwordHash, before.passwordHash, "the dashboard password was rewritten");
  assert.equal(after.missedCallApiKey, before.missedCallApiKey, "the API key was rewritten");
  assert.equal(after.phoneNumberId, before.phoneNumberId, "the WhatsApp number id was rewritten");
  assert.equal(after.wabaId, before.wabaId);
  assert.equal(after.status, before.status);

  // Billing is untouched — settings cannot grant a plan. Compared on the
  // fields that mean something: the implicit record is generated fresh on
  // each read, so its timestamps differ by a millisecond either way.
  const subscription = await w.billing.forBusiness("bs-a");
  assert.equal(subscription.plan, "FREE", "a settings post granted a plan");
  assert.equal(subscription.implicit, true, "a settings post wrote a subscription record");
  assert.equal(await w.store.getSubscription("bs-a"), null, "a subscription was persisted");
  // And tenant B is exactly as it was.
  assert.equal(w.businesses.byId("bs-b").name, "Beta Plumbing");
  assert.equal(w.businesses.byId("bs-b").ownerWhatsApp, B_NUMBER);
});

// ---------------------------------------------------------- validation

test("the owner WhatsApp number is validated, not silently accepted", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);

  for (const bad of ["", "   ", "not a phone", "9888888888", "+91 98888 88888", "+0123456789", "12345", "<script>"]) {
    const res = await handleBusinessSettingsPost(postCtx(session, { ...VALID, ownerWhatsApp: bad }), w);
    assert.equal(res.status, 400, `"${bad}" was accepted`);
    await reload(w);
    assert.equal(w.businesses.byId("bs-a").ownerWhatsApp, A_NUMBER, `"${bad}" reached the record`);
  }

  // And a valid one is accepted, with surrounding whitespace normalised.
  const ok = await handleBusinessSettingsPost(postCtx(session, { ...VALID, ownerWhatsApp: "  +919777777777  " }), w);
  assert.equal(ok.status, 302);
  await reload(w);
  assert.equal(w.businesses.byId("bs-a").ownerWhatsApp, "+919777777777");
});

test("a missing business name is rejected", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);

  const res = await handleBusinessSettingsPost(postCtx(session, { ...VALID, name: "   " }), w);
  assert.equal(res.status, 400);
  await reload(w);
  assert.equal(w.businesses.byId("bs-a").name, "Alpha Electrical");
});

test("applyBusinessProfile reports errors without mutating the original", async () => {
  const existing = businessRecord({ id: "x", name: "Keep", ownerWhatsApp: "+919000000000", missedCallApiKey: "k" });
  const frozen = JSON.stringify(existing);

  const { errors } = applyBusinessProfile(existing, { name: "", ownerWhatsApp: "junk" },
    { isValidPhone: isValidE164, normalizePhone });

  assert.ok(errors.name);
  assert.ok(errors.ownerWhatsApp);
  assert.equal(JSON.stringify(existing), frozen, "the existing record was mutated");
});

// ------------------------------------------------------- authorization

test("OWNER and ADMIN may edit; STAFF may not", async () => {
  const w = await buildWorld();

  for (const role of ["OWNER", "ADMIN"]) {
    const fresh = await buildWorld();
    const session = role === "OWNER"
      ? await sessionFor(fresh, fresh.ownerA)
      : await sessionAs(fresh, "bs-a", "ADMIN", `bs-admin-${role}@example.test`);
    const res = await handleBusinessSettingsPost(postCtx(session, { ...VALID, name: `${role} edited` }), fresh);
    assert.equal(res.status, 302, `${role} could not edit`);
    await reload(fresh);
    assert.equal(fresh.businesses.byId("bs-a").name, `${role} edited`);
  }

  const staffSession = await sessionAs(w, "bs-a", "STAFF", "bs-staff@example.test");
  const denied = await handleBusinessSettingsPost(postCtx(staffSession, { ...VALID, name: "STAFF edited" }), w);
  assert.equal(denied.status, 403);
  await reload(w);
  assert.equal(w.businesses.byId("bs-a").name, "Alpha Electrical", "STAFF changed the business");

  // STAFF may still view, read-only.
  const view = await handleBusinessSettingsGet(getCtx(staffSession), w);
  assert.equal(view.status, 200);
  assert.ok(view.html.includes("not change them"), "STAFF was not told the page is read-only");

  // Only the shell's log-out button may be submittable. Checked by label
  // rather than by the bare presence of type="submit", which the shell
  // now also matches.
  const submits = [...view.html.matchAll(/<button[^>]*type="submit"[^>]*>([^<]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(submits, ["Log out"], `STAFF was shown a save control: ${JSON.stringify(submits)}`);
  assert.ok(!view.html.includes("Save changes"), "STAFF was shown the save button");
  assert.ok(view.html.includes(" disabled"), "STAFF's inputs were left editable");
});

// ---------------------------------------------------- tenant isolation

test("a user cannot update another tenant's business, however they ask", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.ownerA);
  const beforeB = { ...w.businesses.byId("bs-b") };

  for (const forged of [
    { businessId: "bs-b" }, { id: "bs-b" }, { tenantId: "bs-b" }, { business: "bs-b" },
  ]) {
    const res = await handleBusinessSettingsPost(postCtx(sessionA, { ...VALID, ...forged, name: "HIJACKED" }), w);
    assert.equal(res.status, 302);
    await reload(w);
    assert.deepEqual(w.businesses.byId("bs-b"), beforeB, `forged ${JSON.stringify(forged)} reached tenant B`);
    assert.equal(w.businesses.byId("bs-a").name, "HIJACKED", "the edit did not land on the caller's own tenant");
  }
});

test("each owner sees and edits only their own business", async () => {
  const w = await buildWorld();
  const sessionB = await sessionFor(w, w.ownerB);

  const page = await handleBusinessSettingsGet(getCtx(sessionB), w);
  assert.ok(page.html.includes('value="Beta Plumbing"'));
  assert.ok(!page.html.includes("Alpha Electrical"));
  assert.ok(!page.html.includes(A_NUMBER), "tenant A's owner number appeared on tenant B's page");

  await handleBusinessSettingsPost(postCtx(sessionB, { ...VALID, name: "Beta Plumbing Co", ownerWhatsApp: "+919555555555" }), w);
  await reload(w);
  assert.equal(w.businesses.byId("bs-b").ownerWhatsApp, "+919555555555");
  assert.equal(w.businesses.byId("bs-a").ownerWhatsApp, A_NUMBER, "editing B changed A");
});

// ------------------------------------- the number actually gets used

test("a saved owner number is the one later notifications resolve", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);

  await handleBusinessSettingsPost(postCtx(session, { ...VALID, ownerWhatsApp: "+919444444444" }), w);
  await reload(w);

  // This is what routes/dashboard.mjs and routes/webhook.mjs read when
  // deciding where an owner alert goes.
  const business = w.businesses.byId("bs-a");
  assert.equal(business.ownerWhatsApp, "+919444444444");

  const tenantConfig = { ...w.config, MOHAMED_WHATSAPP_NUMBER: business.ownerWhatsApp };
  assert.equal(tenantConfig.MOHAMED_WHATSAPP_NUMBER, "+919444444444",
    "the conversation layer would still notify the old number");
});

test("saving a number sends no WhatsApp message", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);

  await handleBusinessSettingsPost(postCtx(session, { ...VALID, ownerWhatsApp: "+919333333333" }), w);
  assert.equal(w.wa.sent.length, 0, "saving a number sent a message");
});

// --------------------------------- the env-override trap for `default`

test("an edited profile applies to the default business, but credentials stay with the environment", async () => {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("d") };

  await store.saveBusiness(businessRecord({
    id: "default",
    name: "Renamed By Owner",
    ownerWhatsApp: "+919666666666",
    services: ["Rewiring"],
    // A stored record must not be able to redirect the live integration.
    phoneNumberId: "ATTACKER_PHONE",
    missedCallApiKey: "ATTACKER_KEY",
  }));

  const registry = await loadBusinessRegistry(store, config);
  const def = registry.byId("default");

  // Profile edits take effect — this is the whole point of the feature.
  assert.equal(def.name, "Renamed By Owner");
  assert.equal(def.ownerWhatsApp, "+919666666666",
    "an edited owner number was shadowed by the environment");
  assert.deepEqual(def.services, ["Rewiring"]);

  // Credentials and routing remain the environment's.
  assert.equal(def.phoneNumberId, String(TEST_CONFIG.META_PHONE_NUMBER_ID));
  assert.equal(def.missedCallApiKey, TEST_CONFIG.MISSED_CALL_API_KEY);
});

test("a blank stored profile does not wipe the default business's env values", async () => {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("d") };
  await store.saveBusiness(businessRecord({ id: "default", services: ["Only this"] }));

  const def = (await loadBusinessRegistry(store, config)).byId("default");
  assert.equal(def.name, TEST_CONFIG.BUSINESS_NAME, "a blank stored name wiped the live business");
  assert.equal(def.ownerWhatsApp, TEST_CONFIG.MOHAMED_WHATSAPP_NUMBER);
  assert.deepEqual(def.services, ["Only this"]);
});
