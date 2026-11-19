/**
 * Connecting WhatsApp from a phone.
 *
 * On a phone Meta's "popup" is a new tab, and it loses its link back to
 * our page part way through Meta's flow. From then on the SDK fires the
 * login callback with no code, and neither the code nor the
 * WA_EMBEDDED_SIGNUP message can reach the page. In production (19 Nov
 * 2026) every phone attempt logged `embedded_signup_incomplete` with no
 * code, no ids and no Meta messages, while Meta had in fact linked the
 * owner's number to our app.
 *
 * Phones now go to Meta in the same tab: POST /settings/whatsapp/start
 * sends the tab to Meta's dialog with our own redirect_uri and a state,
 * and Meta sends it back to GET /settings/whatsapp/callback with the code.
 *
 * What matters:
 * - both buttons ("keep my WhatsApp Business app" and "a number not on
 *   WhatsApp") end CONNECTED from a phone, with no session cookie on the
 *   way back (it is SameSite=Strict, so the browser leaves it off);
 * - the attempt is bound to the browser that started it, used once, and
 *   re-authorised at the end, so a stray or forged callback connects
 *   nothing to anyone;
 * - the code is spent at once, never logged, and the page it arrives on
 *   replaces its own address;
 * - on the page, phones never get the popup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createIntegrationService, integrationState } from "../lib/integrations.mjs";
import { createMetaVerifier } from "../lib/metaVerify.mjs";
import { embeddedSignupConfig, createEmbeddedSignupClient, SIGNUP_FAILURES } from "../lib/embeddedSignup.mjs";
import {
  SIGNUP_STATE_COOKIE, SIGNUP_STATE_TTL_SECONDS, signupRedirectUri, beginSignupRedirect,
} from "../lib/embeddedSignupRedirect.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleWhatsappConnectStart, handleWhatsappConnectCallback } from "../routes/whatsappConnect.mjs";
import { handleWhatsappSettingsGet } from "../routes/accounts.mjs";
import { dispatch, NON_JSON_POSTS } from "../routes/router.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const PHONE = "777777777777777";
const WABA = "888888888888888";
const TOKEN = "FAKE-PHONE-FLOW-TOKEN";
const CODE = "FAKE-PHONE-FLOW-CODE";
const CALLBACK = "https://example.com/settings/whatsapp/callback";
const APP_SECRET = TEST_CONFIG.META_APP_SECRET;

/**
 * A Graph stand-in that, like Meta, accepts the code only with the exact
 * redirect_uri the dialog was opened with, and only once.
 */
function fakeGraph({ onBizApp }) {
  const calls = [];
  let spent = false;
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    const method = options.method ?? "GET";
    calls.push({ url: u, method, body: options.body ? JSON.parse(options.body) : null });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.includes("/oauth/access_token")) {
      const params = new URL(u).searchParams;
      if (params.get("redirect_uri") !== CALLBACK) {
        return json(400, { error: { code: 100, message: "Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request" } });
      }
      if (params.get("code") !== CODE || spent) {
        return json(400, { error: { code: 100, message: "This authorization code has been used." } });
      }
      spent = true;
      return json(200, { access_token: TOKEN, token_type: "bearer", expires_in: 5184000 });
    }
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
    if (u.includes(`/${WABA}/phone_numbers`)) return json(200, { data: [{ id: PHONE, display_phone_number: "+91 98855 00000" }] });
    if (u.includes(`/${PHONE}?`)) {
      return json(200, {
        id: PHONE, display_phone_number: "+91 98855 00000", verified_name: "Drainage Works",
        quality_rating: "GREEN", platform_type: "CLOUD_API", status: "CONNECTED", is_on_biz_app: onBizApp,
      });
    }
    if (u.includes(`/${WABA}?`)) return json(200, { id: WABA });
    return json(400, { error: { message: "does not exist", code: 100 } });
  };
  return { fetchImpl, calls, exchanges: () => calls.filter((c) => c.url.includes("/oauth/access_token")).length };
}

async function buildWorld({ onBizApp = true, config: extra = {} } = {}) {
  const store = createStore(null);
  const config = {
    ...TEST_CONFIG,
    META_APP_ID: "APP-ID", META_EMBEDDED_SIGNUP_CONFIG_ID: "CONFIG-ID", META_GRAPH_VERSION: "v23.0",
    WHATSAPP_REGISTER_PIN: "123456",
    INTEGRATION_ENCRYPTION_KEY: "e".repeat(64),
    DASHBOARD_PASSWORD_HASH: hashPassword("phone-world-password"),
    META_ACCESS_TOKEN: "", META_PHONE_NUMBER_ID: "",
    ...extra,
  };
  const meta = fakeGraph({ onBizApp });
  const accounts = createAccountService(store);
  const user = await accounts.signUp({ email: "phone-owner@example.test", password: "phone-owner-password" });
  const biz = businessRecord({ id: "phone-biz", name: "Drainage Works", ownerName: "Srinu", ownerWhatsApp: "+914444444444", industry: "Plumbing" });
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

async function sessionFor(w, user = w.user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

/** Presses one of the connect buttons on a phone: the form posts to /settings/whatsapp/start. */
async function press(w, { session, mode = "app" } = {}) {
  return handleWhatsappConnectStart({
    method: "POST", pathname: "/settings/whatsapp/start", query: new URLSearchParams(),
    headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
    rawBody: Buffer.from(`mode=${mode}`),
  }, w);
}

/** What the start response hands the browser: the dialog URL, its state, and the state cookie. */
function launched(res) {
  const dialog = new URL(res.headers.Location);
  const cookie = String(res.headers["Set-Cookie"] ?? "");
  return { dialog, state: dialog.searchParams.get("state"), cookie, cookiePair: cookie.split(";")[0] };
}

/**
 * Meta sends the tab back. Only the state cookie comes with it: the
 * session cookie is SameSite=Strict, so a navigation from facebook.com
 * does not carry it.
 */
function comeBack(w, { query, cookie }) {
  return handleWhatsappConnectCallback({
    method: "GET", pathname: "/settings/whatsapp/callback", query: new URLSearchParams(query),
    headers: cookie ? { cookie } : {}, rawBody: Buffer.alloc(0),
  }, w);
}

/** Where the callback page moves on to. */
function continuesTo(res) {
  const m = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(res.html ?? "");
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function captureLogs() {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

// ------------------------------------------------------------------ start

test("pressing Connect on a phone sends this tab to Meta's dialog, with our callback and a fresh state", async () => {
  const w = await buildWorld();
  const res = await press(w, { session: await sessionFor(w), mode: "app" });

  assert.equal(res.status, 302);
  const { dialog, state, cookie } = launched(res);
  assert.equal(dialog.origin, "https://www.facebook.com");
  assert.equal(dialog.pathname, "/v23.0/dialog/oauth");
  const p = dialog.searchParams;
  assert.equal(p.get("client_id"), "APP-ID");
  assert.equal(p.get("config_id"), "CONFIG-ID");
  assert.equal(p.get("redirect_uri"), CALLBACK);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("override_default_response_type"), "true");
  assert.deepEqual(JSON.parse(p.get("extras")), { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" });
  assert.match(state, /^[0-9a-f]{64}$/);

  // Bound to this browser, readable only on the way back, and only by us.
  assert.ok(cookie.startsWith(`${SIGNUP_STATE_COOKIE}=${state};`));
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/settings/whatsapp/callback", `Max-Age=${SIGNUP_STATE_TTL_SECONDS}`]) {
    assert.ok(cookie.includes(attr), `state cookie lacks ${attr}`);
  }

  // Public identifiers only: no business, user or secret rides to Meta.
  for (const s of [w.biz.id, w.user.id, APP_SECRET]) assert.ok(!res.headers.Location.includes(s));
});

test("the other button asks Meta for a number that is not on WhatsApp", async () => {
  const w = await buildWorld();
  const { dialog } = launched(await press(w, { session: await sessionFor(w), mode: "api" }));
  assert.equal(JSON.parse(dialog.searchParams.get("extras")).featureType, "");
});

test("an attempt lasts long enough to finish Meta's steps, and no longer", async () => {
  const store = createStore(null);
  const saved = [];
  const original = store.saveSession.bind(store);
  store.saveSession = (id, record, ttl) => { saved.push({ id, record, ttl }); return original(id, record, ttl); };
  const { state } = await beginSignupRedirect(store, { businessId: "b1", userId: "u1", mode: "app" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ttl, 30 * 60);
  assert.ok(!saved[0].id.includes(state), "the store key is a hash, not the state itself");
  assert.deepEqual({ ...saved[0].record, createdAt: undefined }, { purpose: "whatsapp-signup", businessId: "b1", userId: "u1", mode: "app", createdAt: undefined });
});

test("signed-out visitors and STAFF cannot start an attempt", async () => {
  const w = await buildWorld();
  const signedOut = await press(w, {});
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.Location, "/leads");
  assert.equal(signedOut.headers["Set-Cookie"], undefined);

  const staff = await w.accounts.signUp({ email: "phone-staff@example.test", password: "phone-staff-password" });
  await w.accounts.addMember({ businessId: w.biz.id, email: "phone-staff@example.test", role: "STAFF" });
  const res = await press(w, { session: await sessionFor(w, staff) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/settings/whatsapp");
  assert.equal(res.headers["Set-Cookie"], undefined);
});

test("with no public address configured, the same-tab flow is not offered", async () => {
  const w = await buildWorld({ config: { WEBHOOK_BASE_URL: "", PUBLIC_BASE_URL: "" } });
  assert.equal(signupRedirectUri(w.config), "");
  const res = await press(w, { session: await sessionFor(w) });
  assert.equal(res.headers.Location, `/settings/whatsapp?e=${SIGNUP_FAILURES.NOT_CONFIGURED}`);

  const { html } = await handleWhatsappSettingsGet({
    method: "GET", pathname: "/settings/whatsapp", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${await sessionFor(w)}` }, rawBody: Buffer.alloc(0),
  }, w);
  assert.ok(!html.includes('action="/settings/whatsapp/start"'));
  assert.match(html, /id="connect-whatsapp-app"/);
});

// ------------------------------------------------------------ the way back

test("'Keep my WhatsApp Business app', finished on a phone, ends CONNECTED", async () => {
  const w = await buildWorld({ onBizApp: true });
  const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w), mode: "app" }));

  const res = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });

  assert.equal(res.status, 200);
  assert.equal(continuesTo(res), "/settings/whatsapp?v=ok");
  const stored = await w.integrations.forBusiness(w.biz.id);
  assert.equal(integrationState(stored), "CONNECTED");
  assert.equal(stored.businessId, w.biz.id);
  assert.equal(stored.phoneNumberId, PHONE);
  assert.equal(stored.wabaId, WABA);
  assert.equal(stored.coexistence, true);

  // Coexistence rules hold on this path too: no re-registration, both syncs started.
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/register")).length, 0);
  const syncs = w.meta.calls.filter((c) => c.url.endsWith(`/${PHONE}/smb_app_data`)).map((c) => c.body.sync_type);
  assert.deepEqual(syncs.sort(), ["history", "smb_app_state_sync"]);

  // One exchange, with exactly the redirect_uri the dialog was opened with.
  assert.equal(w.meta.exchanges(), 1);
});

test("a number that's not on WhatsApp, finished on a phone, is registered and ends CONNECTED", async () => {
  const w = await buildWorld({ onBizApp: false });
  const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w), mode: "api" }));

  const res = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });

  assert.equal(continuesTo(res), "/settings/whatsapp?v=ok");
  const stored = await w.integrations.forBusiness(w.biz.id);
  assert.equal(integrationState(stored), "CONNECTED");
  assert.equal(stored.coexistence, false);
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/register")).length, 1);
  assert.equal(w.meta.calls.filter((c) => c.url.endsWith("/subscribed_apps")).length, 1);
});

test("the page Meta returns to spends the code, forgets its own address, and moves on signed in", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w);
  const { state, cookiePair } = launched(await press(w, { session }));
  const res = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });

  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.match(res.headers["Set-Cookie"], new RegExp(`^${SIGNUP_STATE_COOKIE}=;.*Max-Age=0`));
  assert.match(res.html, /location\.replace\("\/settings\/whatsapp\?v=ok"\)/);
  for (const s of [CODE, TOKEN, state, APP_SECRET]) assert.ok(!res.html.includes(s), "a credential reached the page");

  // The continue page navigates from our own origin, so the Strict session
  // cookie is sent again and the owner sees their connected number.
  const { html } = await handleWhatsappSettingsGet({
    method: "GET", pathname: "/settings/whatsapp", query: new URLSearchParams({ v: "ok" }),
    headers: { cookie: `${COOKIE_NAME}=${session}` }, rawBody: Buffer.alloc(0),
  }, w);
  assert.match(html, /WhatsApp Connected/);
  assert.match(html, /\+91 98855 00000/);
});

// ------------------------------------------------------------------ safety

test("a callback in another browser, or with a forged state, connects nothing and spends nothing", async () => {
  const w = await buildWorld();
  const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w) }));

  // The dialog link finished somewhere that never pressed Connect (no cookie),
  // or by someone holding a different attempt's cookie.
  for (const cookie of [null, `${SIGNUP_STATE_COOKIE}=${"0".repeat(64)}`]) {
    const res = await comeBack(w, { query: { code: CODE, state }, cookie });
    assert.equal(continuesTo(res), `/settings/whatsapp?e=${SIGNUP_FAILURES.EXPIRED}`);
  }
  // A state nobody issued, with a cookie to match it.
  const forged = "f".repeat(64);
  const res = await comeBack(w, { query: { code: CODE, state: forged }, cookie: `${SIGNUP_STATE_COOKIE}=${forged}` });
  assert.equal(continuesTo(res), `/settings/whatsapp?e=${SIGNUP_FAILURES.EXPIRED}`);

  assert.equal(w.meta.exchanges(), 0, "no code was sent to Meta");
  assert.equal(await w.integrations.forBusiness(w.biz.id), null);

  // None of that burned the genuine attempt.
  const real = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });
  assert.equal(continuesTo(real), "/settings/whatsapp?v=ok");
});

test("an attempt is used once: replaying the callback does nothing", async () => {
  const w = await buildWorld();
  const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w) }));
  await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });
  const replay = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });
  assert.equal(continuesTo(replay), `/settings/whatsapp?e=${SIGNUP_FAILURES.EXPIRED}`);
  assert.equal(w.meta.exchanges(), 1);
});

test("someone made STAFF or removed between pressing Connect and finishing connects nothing", async () => {
  for (const [label, demote] of [
    ["removed", async (w, m) => { await w.accounts.removeMember({ businessId: w.biz.id, membershipId: m.id }); }],
    ["made STAFF", async (w, m) => {
      await w.accounts.removeMember({ businessId: w.biz.id, membershipId: m.id });
      await w.accounts.addMember({ businessId: w.biz.id, email: "phone-admin@example.test", role: "STAFF" });
    }],
  ]) {
    const w = await buildWorld();
    const admin = await w.accounts.signUp({ email: "phone-admin@example.test", password: "phone-admin-password" });
    const membership = await w.accounts.addMember({ businessId: w.biz.id, email: "phone-admin@example.test", role: "ADMIN" });
    const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w, admin) }));

    await demote(w, membership);
    const res = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });

    assert.equal(continuesTo(res), `/settings/whatsapp?e=${SIGNUP_FAILURES.EXPIRED}`, label);
    assert.equal(w.meta.exchanges(), 0, label);
    assert.equal(await w.integrations.forBusiness(w.biz.id), null, label);
  }
});

test("Cancel on Meta's page comes back as one of our sentences, and the server log says why", async () => {
  const w = await buildWorld();
  const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w) }));
  const logs = captureLogs();
  let res;
  try {
    res = await comeBack(w, {
      query: { error: "access_denied", error_code: "200", error_description: "Permissions error", error_reason: "user_denied", state },
      cookie: cookiePair,
    });
  } finally {
    logs.restore();
  }
  assert.equal(continuesTo(res), `/settings/whatsapp?e=${SIGNUP_FAILURES.CANCELLED}`);
  assert.equal(w.meta.exchanges(), 0);
  const line = logs.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e?.event === "embedded_signup_incomplete");
  assert.equal(line.via, "redirect");
  assert.equal(line.metaError, "user_denied");
  assert.equal(line.businessId, w.biz.id);
});

test("a number another business already holds is refused on the phone path too", async () => {
  const w = await buildWorld();
  await w.integrations.register({
    businessId: "someone-else", phoneNumberId: PHONE, wabaId: WABA, accessToken: "OTHER-TOKEN",
    appSecret: "", verifyToken: "", status: "CONNECTED",
  });
  const { state, cookiePair } = launched(await press(w, { session: await sessionFor(w) }));
  const res = await comeBack(w, { query: { code: CODE, state }, cookie: cookiePair });
  assert.equal(continuesTo(res), `/settings/whatsapp?e=${SIGNUP_FAILURES.NUMBER_TAKEN}`);
  assert.equal(await w.integrations.forBusiness(w.biz.id), null);
  assert.equal((await w.integrations.byPhoneNumberId(PHONE)).businessId, "someone-else");
});

test("nothing from the phone flow reaches a log: not the code, the state, or the token", async () => {
  const w = await buildWorld();
  const logs = captureLogs();
  let state;
  try {
    const started = launched(await press(w, { session: await sessionFor(w) }));
    state = started.state;
    await comeBack(w, { query: { code: CODE, state }, cookie: started.cookiePair });
  } finally {
    logs.restore();
  }
  const all = logs.lines.join("\n");
  assert.match(all, /embedded_signup_redirect_started/);
  assert.match(all, /embedded_signup_completed/);
  for (const s of [CODE, TOKEN, state, APP_SECRET]) assert.ok(!all.includes(s), "a credential reached the log");
});

test("both routes are in the dispatch table, and the start form is not parsed as JSON", async () => {
  assert.ok(NON_JSON_POSTS.has("/settings/whatsapp/start"));
  const w = await buildWorld();
  const res = await dispatch({
    method: "GET", pathname: "/settings/whatsapp/callback", query: new URLSearchParams({ state: "x" }),
    headers: {}, rawBody: Buffer.alloc(0),
  }, w);
  assert.equal(continuesTo(res), `/settings/whatsapp?e=${SIGNUP_FAILURES.EXPIRED}`);
});

// ------------------------------------------------------------------ the page

async function settingsHtml(w) {
  const { html } = await handleWhatsappSettingsGet({
    method: "GET", pathname: "/settings/whatsapp", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${await sessionFor(w)}` }, rawBody: Buffer.alloc(0),
  }, w);
  return html;
}

test("the connect buttons are a form that works with no JavaScript at all", async () => {
  const html = await settingsHtml(await buildWorld());
  assert.match(html, /<form method="POST" action="\/settings\/whatsapp\/start" id="connect-form">/);
  assert.match(html, /name="mode" value="app" id="connect-whatsapp-app"/);
  assert.match(html, /name="mode" value="api" id="connect-whatsapp"/);
  assert.ok(!html.includes("Connecting through Meta needs JavaScript"));
});

/**
 * Runs the page's connect script against a minimal fake DOM, as a given
 * browser. `click()` on a fake button reports whether the browser would
 * have gone on to submit the form (nothing called preventDefault).
 */
async function runScript(html, { userAgent, maxTouchPoints = 0, mobileHint = undefined, touchOnly = false, connectReply } = {}) {
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    .find((s) => s.includes('getElementById("connect-whatsapp")'));
  assert.ok(source, "the connect script is on the page");

  const el = (id, attrs = {}) => {
    const listeners = {};
    const node = {
      id, hidden: id === "connect-status" || id === "connect-recover", disabled: false, textContent: "", submits: 0,
      getAttribute: (k) => attrs[k] ?? null,
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      click() {
        let prevented = false;
        for (const fn of listeners.click ?? []) fn({ preventDefault() { prevented = true; } });
        if (!prevented && attrs.type === "submit") node.submits += 1;
        return !prevented;
      },
    };
    return node;
  };
  const nodes = {
    "connect-whatsapp": el("connect-whatsapp", { "data-mode": "api", type: "submit" }),
    "connect-whatsapp-app": el("connect-whatsapp-app", { "data-mode": "app", type: "submit" }),
    "connect-form": el("connect-form"),
    "connect-status": el("connect-status"),
    "connect-recover": el("connect-recover"),
    "connect-same-tab": el("connect-same-tab"),
  };
  const logins = [];
  const posts = [];
  const assigned = [];
  const context = {
    document: { getElementById: (id) => nodes[id] ?? null },
    navigator: { userAgent, maxTouchPoints, userAgentData: mobileHint === undefined ? undefined : { mobile: mobileHint } },
    location: { href: "https://example.com/settings/whatsapp", assign: (u) => assigned.push(u) },
    addEventListener: () => {},
    // A device whose only pointer is a finger answers this query.
    matchMedia: (query) => ({ matches: touchOnly && query === "(hover: none) and (pointer: coarse)" }),
    open: () => null,
    FB: { init() {}, login: (cb, opts) => logins.push({ cb, opts }) },
    fetch: async (url, opts) => {
      posts.push({ url, body: JSON.parse(opts.body) });
      const reply = connectReply ?? { ok: false, reason: "signup_missing_code", error: "WhatsApp connection wasn't completed.", redirect: "/settings/whatsapp?e=signup_missing_code" };
      return { ok: false, json: async () => reply };
    },
    setTimeout, URL, JSON, String, Number,
  };
  context.window = context;
  vm.runInNewContext(source, vm.createContext(context));
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { nodes, logins, posts, assigned, settle };
}

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const FACEBOOK_IN_APP = "Mozilla/5.0 (Linux; Android 13; RMX3511) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/489.0.0.40.73;]";
const IPAD_DESKTOP_MODE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_DESKTOP_MODE = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test("on a phone, tablet or in-app browser the buttons never open the popup: the form goes to Meta in this tab", async () => {
  const html = await settingsHtml(await buildWorld());
  for (const [label, opts] of [
    ["Android Chrome", { userAgent: ANDROID }],
    ["iPhone Safari", { userAgent: IPHONE }],
    ["Facebook's in-app browser", { userAgent: FACEBOOK_IN_APP }],
    ["iPad asking for the desktop site", { userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 5 }],
    ["Android Chrome on 'Desktop site'", { userAgent: ANDROID_DESKTOP_MODE, maxTouchPoints: 5, mobileHint: false, touchOnly: true }],
    ["a browser that says it is mobile", { userAgent: WINDOWS, mobileHint: true }],
  ]) {
    const page = await runScript(html, opts);
    assert.equal(page.nodes["connect-whatsapp-app"].click(), true, `${label}: the form was stopped from submitting`);
    assert.equal(page.nodes["connect-whatsapp-app"].submits, 1, label);
    assert.equal(page.logins.length, 0, `${label}: the popup was opened`);
    // A second tap while Meta loads does not post the form twice.
    assert.equal(page.nodes["connect-whatsapp"].click(), false, `${label}: a second tap posted again`);
  }
});

test("on a computer the popup is still used, for both buttons", async () => {
  const html = await settingsHtml(await buildWorld());
  // A plain PC, and a touchscreen laptop (touch points, but a trackpad as its main pointer).
  for (const opts of [{ userAgent: WINDOWS, mobileHint: false }, { userAgent: WINDOWS, mobileHint: false, maxTouchPoints: 10 }]) {
    const page = await runScript(html, opts);
    assert.equal(page.nodes["connect-whatsapp-app"].click(), false, "the popup flow must stop the form");
    assert.equal(page.logins.length, 1);
    assert.equal(page.logins[0].opts.config_id, "CONFIG-ID");
    assert.equal(page.logins[0].opts.extras.featureType, "whatsapp_business_app_onboarding");

    const other = await runScript(html, opts);
    assert.equal(other.nodes["connect-whatsapp"].click(), false);
    assert.equal(other.logins[0].opts.extras.featureType, "");
  }
});

test("when a computer's popup brings nothing back, the owner can carry on in this tab", async () => {
  const html = await settingsHtml(await buildWorld());
  const page = await runScript(html, { userAgent: WINDOWS });
  page.nodes["connect-whatsapp-app"].click();

  // The SDK reports the popup closed with no code.
  page.logins[0].cb({ authResponse: null, status: "unknown" });
  await page.settle();

  // Still logged server-side, but the page stays put and offers this tab.
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].body.code, "");
  assert.deepEqual(page.assigned, []);
  assert.equal(page.nodes["connect-recover"].hidden, false);

  page.nodes["connect-same-tab"].click();
  assert.equal(page.nodes["connect-whatsapp-app"].submits, 1, "the same button's form was submitted");
  assert.equal(page.logins.length, 1, "no second popup");
});
