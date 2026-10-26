/**
 * "No Facebook? We'll set it up for you" on the WhatsApp settings page.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createAccountService, createMembership } from "../lib/users.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleWhatsappAssistPost, supportWhatsAppDigits, assistMessage } from "../routes/whatsappAssist.mjs";
import { handleWhatsappSettingsGet } from "../routes/accounts.mjs";
import { TEST_CONFIG } from "./helpers.mjs";

async function buildWorld(configExtra = {}) {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw-assist"), ...configExtra };
  const accounts = createAccountService(store);
  const owner = await accounts.signUp({ email: "owner@example.test", password: "owner-password" });
  const staff = await accounts.signUp({ email: "staff@example.test", password: "staff-password" });
  await accounts.createBusinessFor(owner, businessRecord({
    id: "biz-a", name: "Beauty Parlour", ownerName: "Vanaja", businessPhone: "+919111111111",
  }));
  await store.saveMembership(createMembership({ userId: staff.id, businessId: "biz-a", role: "STAFF" }));
  const sent = [];
  const w = {
    store, config, accounts, owner, staff, sent,
    integrations: createIntegrationService(store, config),
    mailer: { configured: true, async send(m) { sent.push(m); return true; } },
  };
  w.businesses = await loadBusinessRegistry(store, config);
  return w;
}

const reload = async (w) => { w.businesses = await loadBusinessRegistry(w.store, w.config); return w; };

async function ctxFor(w, user, form = null, query = "") {
  const session = await createSession(w.store, "biz-a", { userId: user.id });
  return {
    headers: { cookie: `${COOKIE_NAME}=${session}` },
    query: new URLSearchParams(query),
    rawBody: form ? Buffer.from(new URLSearchParams(form).toString()) : Buffer.alloc(0),
  };
}

test("the WhatsApp page offers both ways to connect", async () => {
  const w = await buildWorld();
  const res = await handleWhatsappSettingsGet(await ctxFor(w, w.owner), w);
  assert.equal(res.status, 200);
  assert.match(res.html, /No Facebook\? We'll set it up for you/);
  assert.match(res.html, /action="\/settings\/whatsapp\/assist"/);
  assert.match(res.html, /value="\+919111111111"/, "the business phone is filled in");
});

test("a request is saved, emailed to support, and opens a WhatsApp chat with the details", async () => {
  const w = await buildWorld({ SUPPORT_WHATSAPP_NUMBER: "+91 90000 00001" });
  const res = await handleWhatsappAssistPost(await ctxFor(w, w.owner, { number: "98765 43210", bestTime: "evening" }), w);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.Location);
  assert.equal(url.origin + url.pathname, "https://wa.me/919000000001");
  const text = url.searchParams.get("text");
  assert.match(text, /Business: Beauty Parlour/);
  assert.match(text, /\+919876543210/);
  assert.match(text, /Evening/);

  await reload(w);
  const saved = w.businesses.byId("biz-a").setupRequest;
  assert.equal(saved.number, "+919876543210");
  assert.equal(saved.bestTime, "evening");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].to, "support@originutech.in");

  const page = await handleWhatsappSettingsGet(await ctxFor(w, w.owner), w);
  assert.match(page.html, /Requested on .* for \+919876543210/);
  assert.match(page.html, /Update my request/);
});

test("without a support WhatsApp number the owner comes back to a confirmation", async () => {
  const w = await buildWorld();
  const res = await handleWhatsappAssistPost(await ctxFor(w, w.owner, { number: "+919876543210", bestTime: "morning" }), w);
  assert.equal(res.headers.Location, "/settings/whatsapp?a=sent");
  await reload(w);
  const page = await handleWhatsappSettingsGet(await ctxFor(w, w.owner, null, "a=sent"), w);
  assert.match(page.html, /Request received/);
});

test("a mistyped number is refused; a blank one uses the business phone", async () => {
  const w = await buildWorld();
  const bad = await handleWhatsappAssistPost(await ctxFor(w, w.owner, { number: "abc", bestTime: "morning" }), w);
  assert.equal(bad.headers.Location, "/settings/whatsapp?a=bad");
  await reload(w);
  assert.equal(w.businesses.byId("biz-a").setupRequest, undefined);
  const page = await handleWhatsappSettingsGet(await ctxFor(w, w.owner, null, "a=bad"), w);
  assert.match(page.html, /look like a phone number/);

  await handleWhatsappAssistPost(await ctxFor(w, w.owner, { number: "", bestTime: "morning" }), w);
  await reload(w);
  assert.equal(w.businesses.byId("biz-a").setupRequest.number, "+919111111111");
});

test("an unknown best time is stored as any time", async () => {
  const w = await buildWorld();
  await handleWhatsappAssistPost(await ctxFor(w, w.owner, { number: "+919876543210", bestTime: "<script>" }), w);
  await reload(w);
  assert.equal(w.businesses.byId("biz-a").setupRequest.bestTime, "anytime");
});

test("staff can't request setup and signed-out visitors are sent to sign in", async () => {
  const w = await buildWorld();
  const res = await handleWhatsappAssistPost(await ctxFor(w, w.staff, { number: "+919876543210" }), w);
  assert.equal(res.headers.Location, "/settings/whatsapp");
  await reload(w);
  assert.equal(w.businesses.byId("biz-a").setupRequest, undefined);
  const anon = await handleWhatsappAssistPost({ headers: {}, rawBody: Buffer.alloc(0) }, w);
  assert.equal(anon.headers.Location, "/leads");
});

test("support number and message helpers", () => {
  assert.equal(supportWhatsAppDigits({ SUPPORT_WHATSAPP_NUMBER: "" }), "");
  assert.equal(supportWhatsAppDigits({ SUPPORT_WHATSAPP_NUMBER: "nonsense" }), "");
  assert.equal(supportWhatsAppDigits({ SUPPORT_WHATSAPP_NUMBER: "9000000001" }), "919000000001");
  assert.match(assistMessage({ businessName: "X", number: "+919", bestTime: "nope" }), /Any time/);
});
