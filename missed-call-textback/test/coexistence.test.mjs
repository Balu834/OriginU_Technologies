/**
 * Coexistence: a business keeps using the WhatsApp Business app on the same
 * number that MissedCall answers missed calls on.
 *
 * What matters:
 * - onboarding skips number registration (Meta says not to) and starts the
 *   contacts and history syncs, which must happen within 24 hours;
 * - on such a number most messages are ordinary chats with the owner, so the
 *   bot answers only people who just gave a missed call, and steps back as
 *   soon as the owner replies to them from the app;
 * - the extra webhook fields these numbers send never break the webhook.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/store.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { createMetaVerifier } from "../lib/metaVerify.mjs";
import { embeddedSignupConfig, createEmbeddedSignupClient } from "../lib/embeddedSignup.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleWhatsappConnect } from "../routes/whatsappConnect.mjs";
import { handleWhatsappSettingsGet } from "../routes/accounts.mjs";
import { handleWebhookPost, coexistenceMayReply, COEXISTENCE_REPLY_WINDOW_MS } from "../routes/webhook.mjs";
import { TEST_CONFIG, createFakeWa, signBody } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const PHONE = "555555555555555";
const WABA = "666666666666666";
const TOKEN = "FAKE-COEX-TOKEN";
const CODE = "FAKE-COEX-CODE";
const CUSTOMER = "+919876500077";
const APP_SECRET = TEST_CONFIG.META_APP_SECRET;

function fakeGraph({ onBizApp }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    const method = options.method ?? "GET";
    calls.push({ url: u, method, body: options.body ? JSON.parse(options.body) : null });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.includes("/oauth/access_token")) return json(200, { access_token: TOKEN, token_type: "bearer", expires_in: 5184000 });
    if (u.includes("/debug_token")) {
      return json(200, { data: { is_valid: true, granular_scopes: [
        { scope: "whatsapp_business_management", target_ids: [WABA] },
        { scope: "whatsapp_business_messaging", target_ids: [WABA] },
      ] } });
    }
    if (u.endsWith("/subscribed_apps")) return json(200, { success: true });
    if (u.endsWith("/register")) return json(200, { success: true });
    if (u.endsWith("/smb_app_data")) return json(200, { messaging_product: "whatsapp", request_id: `req-${calls.length}` });
    if (u.endsWith("/message_templates") && method === "POST") return json(200, { id: "tpl", status: "PENDING", category: "UTILITY" });
    if (/\/\d+\/phone_numbers/.test(u)) return json(200, { data: [{ id: PHONE }] });
    if (u.includes(`/${PHONE}?`)) {
      return json(200, {
        id: PHONE, display_phone_number: "+91 98765 00077", verified_name: "Sandy's Artistry",
        quality_rating: "GREEN", platform_type: "CLOUD_API", status: "CONNECTED", is_on_biz_app: onBizApp,
      });
    }
    return json(400, { error: { message: "does not exist", code: 100 } });
  };
  return { fetchImpl, calls };
}

async function buildWorld({ onBizApp = true } = {}) {
  const store = createStore(null);
  const config = {
    ...TEST_CONFIG,
    META_APP_ID: "APP-ID", META_EMBEDDED_SIGNUP_CONFIG_ID: "CONFIG-ID", META_GRAPH_VERSION: "v23.0",
    WHATSAPP_REGISTER_PIN: "123456",
    INTEGRATION_ENCRYPTION_KEY: "d".repeat(64),
    DASHBOARD_PASSWORD_HASH: hashPassword("coex-world-password"),
    META_ACCESS_TOKEN: "", META_PHONE_NUMBER_ID: "",
  };
  const meta = fakeGraph({ onBizApp });
  const accounts = createAccountService(store);
  const user = await accounts.signUp({ email: "coex@example.test", password: "coex-owner-password" });
  const biz = businessRecord({ id: "coex-biz", name: "Sandy's Artistry", ownerName: "Sandy", ownerWhatsApp: "+913333333333", industry: "Makeup artist" });
  await accounts.createBusinessFor(user, biz);
  const signup = embeddedSignupConfig(config);
  return {
    store, config, accounts, meta, user, biz, templates, wa: createFakeWa(),
    integrations: createIntegrationService(store, config),
    businesses: await loadBusinessRegistry(store, config),
    metaVerifier: createMetaVerifier({ fetchImpl: meta.fetchImpl }),
    embeddedSignup: createEmbeddedSignupClient({
      appId: signup.appId, appSecret: config.META_APP_SECRET, graphVersion: signup.graphVersion,
      registerPin: config.WHATSAPP_REGISTER_PIN, fetchImpl: meta.fetchImpl,
    }),
  };
}

async function sessionFor(w) {
  const [m] = await w.accounts.membershipsOf(w.user.id);
  return createSession(w.store, m.businessId, { userId: w.user.id });
}

async function connect(w, body) {
  const session = await sessionFor(w);
  return handleWhatsappConnect({
    method: "POST", pathname: "/settings/whatsapp/connect", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${session}` },
    rawBody: Buffer.from(JSON.stringify({ code: CODE, phoneNumberId: PHONE, wabaId: WABA, ...body })),
  }, w);
}

/** Signs and delivers one webhook change; returns the Graph sends it caused. */
async function deliver(w, change) {
  const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [change] }] }));
  const sends = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    sends.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.OUT${sends.length}` }] }) };
  };
  try {
    const result = handleWebhookPost({
      method: "POST", pathname: "/webhook", query: new URLSearchParams(),
      headers: { "x-hub-signature-256": signBody(raw, APP_SECRET) }, rawBody: raw,
    }, w);
    if (result.afterAck) await result.afterAck();
    return sends;
  } finally {
    globalThis.fetch = original;
  }
}

const customerMessage = (text) => ({
  field: "messages",
  value: {
    metadata: { phone_number_id: PHONE, display_phone_number: "919876500077" },
    messages: [{ id: `wamid.${crypto.randomUUID()}`, from: CUSTOMER.slice(1), type: "text", text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }],
  },
});

const ownerEcho = (text) => ({
  field: "smb_message_echoes",
  value: {
    messaging_product: "whatsapp",
    metadata: { phone_number_id: PHONE, display_phone_number: "919876500077" },
    message_echoes: [{ from: "919876500077", to: CUSTOMER.slice(1), id: `wamid.${crypto.randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  },
});

// ------------------------------------------------------------------ rules

test("the bot may reply only after a recent missed call, and not once the owner has replied", () => {
  const now = Date.now();
  assert.deepEqual(coexistenceMayReply({ lastMissedCallAt: null, lastOwnerReplyAt: null, now }), { ok: false, reason: "no_recent_missed_call" });
  assert.equal(coexistenceMayReply({ lastMissedCallAt: now - COEXISTENCE_REPLY_WINDOW_MS - 1, now }).ok, false);
  assert.equal(coexistenceMayReply({ lastMissedCallAt: now - 60_000, now }).ok, true);
  assert.deepEqual(coexistenceMayReply({ lastMissedCallAt: now - 60_000, lastOwnerReplyAt: now - 30_000, now }), { ok: false, reason: "owner_replied" });
  // An owner reply from before this missed call doesn't silence the new one.
  assert.equal(coexistenceMayReply({ lastMissedCallAt: now - 60_000, lastOwnerReplyAt: now - 3_600_000, now }).ok, true);
});

// ------------------------------------------------------------------ onboarding

test("a number on the WhatsApp Business app is not re-registered, and both syncs start", async () => {
  const w = await buildWorld({ onBizApp: true });
  const res = await connect(w, { coexistence: true });
  assert.equal(res.status, 200);
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/register")).length, 0, "Meta says never to register a coexistence number");
  const syncs = w.meta.calls.filter((c) => c.url.endsWith(`/${PHONE}/smb_app_data`)).map((c) => c.body.sync_type);
  assert.deepEqual(syncs.sort(), ["history", "smb_app_state_sync"]);
  const stored = await w.integrations.forBusiness(w.biz.id);
  assert.equal(stored.coexistence, true);
});

test("Meta's answer decides coexistence, even if the browser said otherwise", async () => {
  const w = await buildWorld({ onBizApp: true });
  await connect(w, { coexistence: false });
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/register")).length, 0);
  assert.equal((await w.integrations.forBusiness(w.biz.id)).coexistence, true);
});

test("a normal API-only number is still registered and gets no app syncs", async () => {
  const w = await buildWorld({ onBizApp: false });
  const res = await connect(w, {});
  assert.equal(res.status, 200);
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/register")).length, 1);
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/smb_app_data")).length, 0);
  assert.equal((await w.integrations.forBusiness(w.biz.id)).coexistence, false);
});

// ------------------------------------------------------------------ webhook

test("on a coexistence number, ordinary chats are left to the owner", async () => {
  const w = await buildWorld();
  await connect(w, { coexistence: true });
  const sends = await deliver(w, customerMessage("Hi, are you free on Sunday?"));
  assert.equal(sends.length, 0, "no missed call, so the owner handles this chat in the app");
});

test("a missed caller gets the bot, until the owner replies from the app", async () => {
  const w = await buildWorld();
  await connect(w, { coexistence: true });
  await scopedToBusiness(w.store, w.biz.id).markMissedCall(CUSTOMER, Date.now() - 1000);

  const first = await deliver(w, customerMessage("Bridal makeup for my wedding"));
  assert.ok(first.length >= 1, "the missed caller is answered");

  await deliver(w, ownerEcho("Hi! Yes I'm free that day, sending prices now"));
  const after = await deliver(w, customerMessage("Great, thank you"));
  assert.equal(after.length, 0, "the owner took over, so the bot stays quiet");
});

test("owner echoes are never treated as customer messages", async () => {
  const w = await buildWorld();
  await connect(w, { coexistence: true });
  await scopedToBusiness(w.store, w.biz.id).markMissedCall(CUSTOMER, Date.now() - 1000);
  const sends = await deliver(w, ownerEcho("Hello from the app"));
  assert.equal(sends.length, 0);
  const leads = await scopedToBusiness(w.store, w.biz.id).listLeads();
  assert.equal(leads.length, 0);
});

test("history, contact-sync and account_update webhooks are absorbed without replies", async () => {
  const w = await buildWorld();
  await connect(w, { coexistence: true });
  const meta = { phone_number_id: PHONE, display_phone_number: "919876500077" };
  const history = await deliver(w, { field: "history", value: { messaging_product: "whatsapp", metadata: meta, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: CUSTOMER.slice(1), messages: [{ from: CUSTOMER.slice(1), id: "wamid.H1", timestamp: "1700000000", type: "text", text: { body: "old chat" } }] }] }] } });
  const contacts = await deliver(w, { field: "smb_app_state_sync", value: { messaging_product: "whatsapp", metadata: meta, state_sync: [{ type: "contact", contact: { full_name: "Ravi", phone_number: "919000000000" }, action: "add", metadata: { timestamp: "1700000000" } }] } });
  const account = await deliver(w, { field: "account_update", value: { phone_number: "919876500077", event: "PARTNER_REMOVED", disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" } } });
  assert.equal(history.length + contacts.length + account.length, 0);
});

test("a normal number keeps answering every message, missed call or not", async () => {
  const w = await buildWorld({ onBizApp: false });
  await connect(w, {});
  const sends = await deliver(w, customerMessage("AC not cooling"));
  assert.ok(sends.length >= 1);
});

// ------------------------------------------------------------------ page

test("the connect page offers keeping the WhatsApp Business app", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w);
  const res = await handleWhatsappSettingsGet({
    method: "GET", pathname: "/settings/whatsapp", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${session}` }, rawBody: Buffer.alloc(0),
  }, w);
  assert.match(res.html, /Keep my WhatsApp Business app/);
  assert.match(res.html, /data-mode="app"/);
  assert.match(res.html, /whatsapp_business_app_onboarding/);
  assert.match(res.html, /Use a number that's not on WhatsApp|Use a number that&#39;s not on WhatsApp/);
});
