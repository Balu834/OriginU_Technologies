/**
 * The missed-call key a signed-up business needs before its phone can
 * report anything.
 *
 * Before this, only the env-configured business had a key. A business that
 * signed up, connected WhatsApp and installed the phone automation still
 * could not trigger a single message. These tests pin the new surface to
 * the rules every other settings route follows, and prove the one thing
 * that matters end to end: a key created here authenticates /missed-call
 * for that business and for no other.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService } from "../lib/billing.mjs";
import { createUsageService } from "../lib/usage.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handlePhoneSetupGet, handlePhoneKeyPost, generateMissedCallKey } from "../routes/phoneSetup.mjs";
import { handleMissedCall } from "../routes/missedCall.mjs";
import { TEST_CONFIG, createFakeWa, jsonCtx } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

async function buildWorld() {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw-phone") };
  const accounts = createAccountService(store);

  const ownerA = await accounts.signUp({ email: "ph-a@example.test", password: "ph-a-password" });
  const ownerB = await accounts.signUp({ email: "ph-b@example.test", password: "ph-b-password" });
  // Exactly what signup produces: a business with NO missed-call key.
  await accounts.createBusinessFor(ownerA, businessRecord({ id: "ph-a", name: "Alpha Clinic", ownerName: "Anita", ownerWhatsApp: "+919111111111" }));
  await accounts.createBusinessFor(ownerB, businessRecord({ id: "ph-b", name: "Beta Repairs", ownerName: "Bharat", ownerWhatsApp: "+919222222222" }));

  const w = {
    store, config, accounts, templates, wa: createFakeWa(),
    billing: createBillingService(store), usage: createUsageService(store),
    ownerA, ownerB,
  };
  w.businesses = await loadBusinessRegistry(store, config);
  return w;
}

const reload = async (w) => { w.businesses = await loadBusinessRegistry(w.store, w.config); return w; };

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

const ctx = (method, pathname, session) => ({
  method, pathname, query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {}, rawBody: Buffer.alloc(0),
});

const keyFrom = (html) => String(html).match(/id="new-key"[^>]*value="([^"]+)"/)?.[1] ?? null;

const missedCall = (key, callerNumber = "+919876500001") =>
  jsonCtx({ method: "POST", pathname: "/missed-call", headers: { authorization: `Bearer ${key}` }, body: { callerNumber } });

test("a freshly signed-up business has no key, and the page says so", async () => {
  const w = await buildWorld();
  const res = await handlePhoneSetupGet(ctx("GET", "/settings/phone", await sessionFor(w, w.ownerA)), w);

  assert.equal(res.status, 200);
  assert.match(String(res.html), /No key yet/);
  assert.match(String(res.html), /MacroDroid/);
  assert.match(String(res.html), /https:\/\/example\.com\/missed-call/, "the guide shows this deployment's endpoint");
  assert.equal(keyFrom(res.html), null);
});

test("signed out, the page redirects and the POST refuses", async () => {
  const w = await buildWorld();
  assert.equal((await handlePhoneSetupGet(ctx("GET", "/settings/phone", null), w)).status, 302);
  assert.equal((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", null), w)).status, 401);
});

test("creating a key shows it once, stores it, and never shows it again", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);

  const created = await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", session), w);
  assert.equal(created.status, 200);
  const key = keyFrom(created.html);
  assert.match(key, /^mc_[A-Za-z0-9_-]{40,}$/);

  await reload(w);
  assert.equal(w.businesses.byId("ph-a").missedCallApiKey, key, "the key survives a reload");

  assert.match(String(created.html), new RegExp(`id="new-key-header"[^>]*value="Bearer ${key}"`), "the header line is ready to copy");

  const again = await handlePhoneSetupGet(ctx("GET", "/settings/phone", session), w);
  assert.equal(String(again.html).includes(key), false, "the key is never rendered a second time");
  assert.match(String(again.html), /A key is active/);
});

test("the guide uses the public domain and gives every MacroDroid value a copy box", async () => {
  const w = await buildWorld();
  w.config = { ...w.config, PUBLIC_BASE_URL: "https://missedcall.example.in/" };
  const html = String((await handlePhoneSetupGet(ctx("GET", "/settings/phone", await sessionFor(w, w.ownerA)), w)).html);

  assert.match(html, /id="copy-url"[^>]*value="https:\/\/missedcall\.example\.in\/missed-call"/);
  assert.doesNotMatch(html, /https:\/\/example\.com\/missed-call/, "the webhook host is not shown when a public domain exists");
  assert.match(html, /id="copy-body"[^>]*value="\{&quot;callerNumber&quot;:&quot;\[call_number\]&quot;\}"/);
  assert.match(html, /Not GET/);
});

test("the key authenticates /missed-call for that business and sends on its name", async () => {
  const w = await buildWorld();
  const key = keyFrom((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", await sessionFor(w, w.ownerA)), w)).html);
  await reload(w);

  // No `integrations` in this world, so the shared fake client stands in
  // for the business's own WhatsApp connection.
  const res = await handleMissedCall(missedCall(key), w);
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, true);
  assert.equal(w.wa.sent[0].bodyParams.business_name, "Alpha Clinic");
  assert.equal(w.wa.sent[0].bodyParams.owner_name, "Anita");
  // The request above carried no timestamp, exactly as the phone guide's
  // body does, and the business has no template of its own recorded.
  assert.equal(w.wa.sent[0].templateName, TEST_CONFIG.WHATSAPP_MISSED_CALL_TEMPLATE);
  assert.equal(w.wa.sent[0].languageCode, TEST_CONFIG.WHATSAPP_TEMPLATE_LANGUAGE);
});

test("a timestamp is optional, but a garbage one is still rejected", async () => {
  const w = await buildWorld();
  const key = keyFrom((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", await sessionFor(w, w.ownerA)), w)).html);
  await reload(w);
  const bad = jsonCtx({
    method: "POST", pathname: "/missed-call", headers: { authorization: `Bearer ${key}` },
    body: { callerNumber: "+919876500009", timestamp: "not-a-date" },
  });
  assert.equal((await handleMissedCall(bad, w)).status, 400);
});

test("one business's key never authenticates as another, and a made-up key is refused", async () => {
  const w = await buildWorld();
  const keyA = keyFrom((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", await sessionFor(w, w.ownerA)), w)).html);
  const keyB = keyFrom((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", await sessionFor(w, w.ownerB)), w)).html);
  await reload(w);

  assert.notEqual(keyA, keyB);
  await handleMissedCall(missedCall(keyB), w);
  assert.equal(w.wa.sent.at(-1).bodyParams.business_name, "Beta Repairs");

  const forged = await handleMissedCall(missedCall(generateMissedCallKey()), w);
  assert.equal(forged.status, 401);
});

test("creating a new key stops the old one working", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.ownerA);
  const oldKey = keyFrom((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", session), w)).html);
  await reload(w);
  const newKey = keyFrom((await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", session), w)).html);
  await reload(w);

  assert.notEqual(oldKey, newKey);
  assert.equal((await handleMissedCall(missedCall(oldKey), w)).status, 401);
  assert.equal((await handleMissedCall(missedCall(newKey, "+919876500002"), w)).status, 200);
});

test("staff can read the guide but cannot create a key", async () => {
  const w = await buildWorld();
  const staff = await w.accounts.signUp({ email: "ph-staff@example.test", password: "staff-password-x" });
  await w.accounts.addMember({ businessId: "ph-a", email: "ph-staff@example.test", role: "STAFF" });
  const session = await createSession(w.store, "ph-a", { userId: staff.id });

  assert.equal((await handlePhoneSetupGet(ctx("GET", "/settings/phone", session), w)).status, 200);
  const res = await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", session), w);
  assert.equal(res.status, 403);
  await reload(w);
  assert.equal(w.businesses.byId("ph-a").missedCallApiKey, "", "no key was written");
});

test("the env-configured business's key cannot be replaced from the page", async () => {
  const w = await buildWorld();
  const session = await createSession(w.store, "default");
  const res = await handlePhoneKeyPost(ctx("POST", "/settings/phone/key", session), w);
  // Either refused outright or never reached; what must not happen is a new key.
  assert.notEqual(res.status, 200);
  await reload(w);
  assert.equal(w.businesses.byId("default").missedCallApiKey, TEST_CONFIG.MISSED_CALL_API_KEY);
});
