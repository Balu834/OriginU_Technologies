/**
 * Customer-facing WhatsApp onboarding — Meta Embedded Signup.
 *
 * The point of the redesign these tests cover is that a business owner
 * never handles a Meta credential. That is a security property as much as
 * a usability one, so the assertions here are mostly about what must NOT
 * happen: no token in a response, no token in the markup, no token in a
 * log, no credential in a URL, and above all no way for one tenant's
 * connection to become another tenant's.
 *
 * Meta is mocked at fetch. Every assertion about state reads the PERSISTED
 * integration record, never the rendered page — a CSS class is not a
 * connection status.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createIntegrationService, integrationState } from "../lib/integrations.mjs";
import { createMetaVerifier, FAILURE_REASONS } from "../lib/metaVerify.mjs";
import {
  embeddedSignupConfig, createEmbeddedSignupClient, SIGNUP_FAILURES, signupMessage,
} from "../lib/embeddedSignup.mjs";
import { loadBusinessRegistry, businessRecord, onboardingStatus } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleWhatsappSettingsGet, handleWhatsappSettingsPost } from "../routes/accounts.mjs";
import { handleWhatsappConnect, handleWhatsappTest } from "../routes/whatsappConnect.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { overviewPage } from "../lib/overviewView.mjs";
import { TEST_CONFIG, createFakeWa, signBody } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const PHONE_A = "111111111111111";
const WABA_A = "222222222222222";
const TOKEN_A = "FAKE-BUSINESS-TOKEN-ALPHA";
const CODE_A = "FAKE-EXCHANGE-CODE-ALPHA";

const PHONE_B = "333333333333333";
const WABA_B = "444444444444444";
const TOKEN_B = "FAKE-BUSINESS-TOKEN-BETA";
const CODE_B = "FAKE-EXCHANGE-CODE-BETA";

const APP_SECRET = TEST_CONFIG.META_APP_SECRET;
const CUSTOMER = "+919876500011";

/** Every string that must never appear in a response, a page or a log. */
const ALL_SECRETS = [TOKEN_A, TOKEN_B, CODE_A, CODE_B, APP_SECRET];

// ------------------------------------------------------------ a fake Meta

/**
 * One Graph stand-in for both the signup client and the verifier.
 *
 * `codes` maps an exchangeable code to the business token Meta would
 * return for it, so "the customer completed the flow" and "the customer's
 * token reaches their own number" are separate, independently falsifiable
 * facts.
 */
function fakeGraph({ codes = {}, numbers = {}, wabas = {}, validTokens = [], failExchange = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    const method = options.method ?? "GET";
    const token = (options.headers?.Authorization ?? "").replace("Bearer ", "");
    calls.push({ url: u, method, token, body: options.body ? JSON.parse(options.body) : null });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    if (u.includes("/oauth/access_token")) {
      if (failExchange) {
        return json(400, { error: { message: "Invalid verification code format.", code: 100, fbtrace_id: "TX" } });
      }
      const code = new URL(u).searchParams.get("code");
      const granted = codes[code];
      if (!granted) {
        return json(400, { error: { message: "Invalid verification code format.", code: 100, fbtrace_id: "TX" } });
      }
      return json(200, { access_token: granted, token_type: "bearer" });
    }

    if (!validTokens.includes(token)) {
      return json(401, { error: { message: "Malformed access token", type: "OAuthException", code: 190, fbtrace_id: "T1" } });
    }

    if (u.endsWith("/subscribed_apps")) return json(200, { success: true });
    if (u.endsWith("/register")) return json(200, { success: true });

    const wabaMatch = /\/(\d+)\/phone_numbers/.exec(u);
    if (wabaMatch) {
      const owned = wabas[wabaMatch[1]];
      if (!owned) return json(400, { error: { message: "does not exist", code: 100, fbtrace_id: "T2" } });
      return json(200, { data: owned.map((id) => ({ id })) });
    }

    const idMatch = /\/(\d+)\?/.exec(u);
    const number = idMatch ? numbers[idMatch[1]] : null;
    if (!number) return json(400, { error: { message: "does not exist", code: 100, fbtrace_id: "T3" } });
    return json(200, number);
  };
  return { fetchImpl, calls };
}

const healthyNumber = (id, display) => ({
  id,
  display_phone_number: display,
  verified_name: "Test Business",
  quality_rating: "GREEN",
  platform_type: "CLOUD_API",
  status: "CONNECTED",
});

/** A Meta that accepts everything each tenant legitimately owns. */
const honestMeta = (extra = {}) => fakeGraph({
  codes: { [CODE_A]: TOKEN_A, [CODE_B]: TOKEN_B },
  numbers: { [PHONE_A]: healthyNumber(PHONE_A, "+91 98765 00001"), [PHONE_B]: healthyNumber(PHONE_B, "+91 98765 00002") },
  wabas: { [WABA_A]: [PHONE_A], [WABA_B]: [PHONE_B] },
  validTokens: [TOKEN_A, TOKEN_B],
  ...extra,
});

// ------------------------------------------------------------------ world

const SIGNUP_ENV = {
  META_APP_ID: "APP-ID-PUBLIC",
  META_EMBEDDED_SIGNUP_CONFIG_ID: "CONFIG-ID-PUBLIC",
  META_GRAPH_VERSION: "v23.0",
  WHATSAPP_REGISTER_PIN: "123456",
};

async function buildWorld({ meta = honestMeta(), signupEnv = SIGNUP_ENV } = {}) {
  const store = createStore(null);
  const config = {
    ...TEST_CONFIG,
    ...signupEnv,
    INTEGRATION_ENCRYPTION_KEY: "c".repeat(64),
    DASHBOARD_PASSWORD_HASH: hashPassword("world-password-x"),
    // No env-backed legacy tenant in play: these tests are about
    // self-service businesses only.
    META_ACCESS_TOKEN: "",
    META_PHONE_NUMBER_ID: "",
  };

  const accounts = createAccountService(store);
  const integrations = createIntegrationService(store, config);

  const userA = await accounts.signUp({ email: "signup-a@example.test", password: "signup-a-password" });
  const userB = await accounts.signUp({ email: "signup-b@example.test", password: "signup-b-password" });

  const bizA = businessRecord({
    id: "sbiz-a", name: "Alpha Electrical", ownerName: "Anita",
    ownerWhatsApp: "+911111111111", services: ["Electrical repair"], areas: ["Whitefield"],
  });
  const bizB = businessRecord({
    id: "sbiz-b", name: "Beta Plumbing", ownerName: "Bharat",
    ownerWhatsApp: "+912222222222", services: ["Plumbing"], areas: ["Madhapur"],
  });
  await accounts.createBusinessFor(userA, bizA);
  await accounts.createBusinessFor(userB, bizB);

  const signup = embeddedSignupConfig(config);
  const world = {
    store, config, accounts, integrations, meta,
    businesses: await loadBusinessRegistry(store, config),
    metaVerifier: createMetaVerifier({ fetchImpl: meta.fetchImpl }),
    embeddedSignup: signup.available
      ? createEmbeddedSignupClient({
          appId: signup.appId,
          appSecret: config.META_APP_SECRET,
          graphVersion: signup.graphVersion,
          registerPin: config.WHATSAPP_REGISTER_PIN,
          fetchImpl: meta.fetchImpl,
        })
      : null,
    wa: createFakeWa(), templates, userA, userB, bizA, bizB,
  };
  return world;
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

/** A STAFF member of business A, for the role checks. */
async function staffSessionFor(w, email = "staff-signup@example.test") {
  const user = await w.accounts.signUp({ email, password: "staff-signup-password" });
  await w.accounts.addMember({ businessId: w.bizA.id, email, role: "STAFF" });
  return sessionFor(w, user);
}

function jsonCtx({ session, body = {}, pathname = "/settings/whatsapp/connect" }) {
  return {
    method: "POST", pathname,
    query: new URLSearchParams(),
    headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function pageCtx({ session, query = {} }) {
  return {
    method: "GET", pathname: "/settings/whatsapp",
    query: new URLSearchParams(query),
    headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
    rawBody: Buffer.alloc(0),
  };
}

const connect = (w, session, body) => handleWhatsappConnect(jsonCtx({ session, body }), w);

const GOOD_A = { code: CODE_A, phoneNumberId: PHONE_A, wabaId: WABA_A };

/** Signs and delivers one webhook payload, with the network stubbed out. */
async function deliver(w, phoneNumberId, text) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: phoneNumberId, display_phone_number: "000" },
          messages: [{
            id: `wamid.${crypto.randomUUID()}`, from: CUSTOMER.replace("+", ""), type: "text",
            text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)),
          }],
        },
      }],
    }],
  };

  const raw = Buffer.from(JSON.stringify(payload));
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options.headers?.Authorization ?? "" });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.OUT${calls.length}` }] }) };
  };

  try {
    const result = handleWebhookPost({
      method: "POST", pathname: "/webhook", query: new URLSearchParams(),
      headers: { "x-hub-signature-256": signBody(raw, APP_SECRET) }, rawBody: raw,
    }, w);
    if (result.afterAck) await result.afterAck();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

function captureLogs() {
  const lines = [];
  const log = console.log, error = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => { console.log = log; console.error = error; } };
}

// ============================================== 1. configuration honesty

test("the Connect button is offered only when this deployment can actually complete it", () => {
  const full = embeddedSignupConfig({ ...SIGNUP_ENV, META_APP_SECRET: APP_SECRET });
  assert.equal(full.available, true);
  assert.equal(full.appId, "APP-ID-PUBLIC");
  assert.equal(full.configId, "CONFIG-ID-PUBLIC");

  // Each missing piece independently disables the flow rather than
  // producing a button that opens an empty popup.
  for (const missing of ["META_APP_ID", "META_EMBEDDED_SIGNUP_CONFIG_ID", "META_APP_SECRET"]) {
    const env = { ...SIGNUP_ENV, META_APP_SECRET: APP_SECRET, [missing]: "" };
    assert.equal(embeddedSignupConfig(env).available, false, `${missing} missing still offered the flow`);
  }
});

test("the signup config carries the two public ids and never the app secret", () => {
  const cfg = embeddedSignupConfig({ ...SIGNUP_ENV, META_APP_SECRET: APP_SECRET });
  assert.ok(!JSON.stringify(cfg).includes(APP_SECRET));
});

// ==================================================== 2. the main screen

test("the main screen asks for no Meta credential, and hides the manual form behind Advanced setup", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  const { html } = await handleWhatsappSettingsGet(pageCtx({ session }), w);

  // The one control a business owner is meant to use.
  assert.match(html, /Connect your WhatsApp Business account/);
  assert.match(html, /id="connect-whatsapp"/);
  assert.match(html, /Securely connect your WhatsApp Business account through Meta/);

  // The six technical fields still exist — inside the disclosure, with a
  // warning, and never as the first thing a customer sees.
  const advanced = html.slice(html.indexOf("<details"));
  assert.match(advanced, /Advanced \/ Manual Setup/);
  assert.match(advanced, /Manual setup is intended for technical administrators/);
  for (const field of ["phoneNumberId", "displayPhoneNumber", "wabaId", "accessToken", "appSecret", "verifyToken"]) {
    assert.ok(advanced.includes(`name="${field}"`), `${field} is no longer available in Advanced setup`);
    assert.ok(
      !html.slice(0, html.indexOf("<details")).includes(`name="${field}"`),
      `${field} is still on the main screen`
    );
  }
});

test("with no Meta app configured the page says so instead of faking a button", async () => {
  const w = await buildWorld({ signupEnv: {} });
  const session = await sessionFor(w, w.userA);
  const { html } = await handleWhatsappSettingsGet(pageCtx({ session }), w);

  assert.ok(!html.includes('id="connect-whatsapp"'), "a button was rendered that cannot complete a connection");
  assert.ok(!html.includes("connect.facebook.net"), "Meta's SDK was loaded with nothing to launch");
  assert.match(html, /isn't switched on for this deployment yet/);
  // The manual path is still there, which is the whole point of keeping it.
  assert.match(html, /Advanced \/ Manual Setup/);
});

test("the launch script carries only public identifiers", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  const { html } = await handleWhatsappSettingsGet(pageCtx({ session }), w);

  assert.match(html, /"appId":"APP-ID-PUBLIC"/);
  assert.match(html, /"configId":"CONFIG-ID-PUBLIC"/);
  for (const secret of ALL_SECRETS) assert.ok(!html.includes(secret), "a credential reached the page");
});

// ================================================ 3. completing the flow

test("a completed Meta flow stores an encrypted, verified integration on the right business", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await connect(w, session, GOOD_A);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.redirect, "/settings/whatsapp?v=ok");

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(stored.businessId, w.bizA.id);
  assert.equal(stored.phoneNumberId, PHONE_A);
  assert.equal(stored.wabaId, WABA_A);
  assert.equal(stored.displayPhoneNumber, "+91 98765 00001");

  // CONNECTED only because Meta was asked and said yes.
  assert.equal(integrationState(stored), "CONNECTED");
  assert.ok(stored.lastVerifiedAt);

  // At rest: ciphertext, not the token.
  assert.ok(!JSON.stringify(stored).includes(TOKEN_A), "the token was stored in the clear");
  assert.equal(w.integrations.secretsOf(stored).accessToken, TOKEN_A);

  // Business B is untouched by A's connection.
  assert.equal(await w.integrations.forBusiness(w.bizB.id), null);
});

test("the flow subscribes our app to the customer's WABA and registers their number", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);

  const subscribe = w.meta.calls.find((c) => c.url.endsWith("/subscribed_apps"));
  assert.ok(subscribe, "the app was never subscribed to the customer's WABA");
  assert.equal(subscribe.method, "POST");
  assert.ok(subscribe.url.includes(WABA_A));
  assert.equal(subscribe.token, TOKEN_A, "someone else's token was used to subscribe");

  const register = w.meta.calls.find((c) => c.url.endsWith("/register"));
  assert.ok(register, "the number was never registered for Cloud API");
  assert.equal(register.body.messaging_product, "whatsapp");
  assert.equal(register.body.pin, "123456");
});

test("with no register PIN configured, registration is skipped rather than invented", async () => {
  const w = await buildWorld({ signupEnv: { ...SIGNUP_ENV, WHATSAPP_REGISTER_PIN: "" } });
  const res = await connect(w, await sessionFor(w, w.userA), GOOD_A);

  assert.equal(res.body.ok, true, "a skipped registration should not fail an otherwise good connection");
  assert.ok(!w.meta.calls.some((c) => c.url.endsWith("/register")), "a PIN was invented");
});

test("the code is exchanged server-side, and the app secret never goes near the browser", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);

  const exchange = w.meta.calls.find((c) => c.url.includes("/oauth/access_token"));
  assert.ok(exchange, "the code was never exchanged");
  const params = new URL(exchange.url).searchParams;
  assert.equal(params.get("code"), CODE_A);
  assert.equal(params.get("client_id"), "APP-ID-PUBLIC");
  assert.equal(params.get("client_secret"), APP_SECRET);
  // A redirect_uri would be rejected: this code came from FB.login, not a redirect.
  assert.equal(params.get("redirect_uri"), null);
});

// ================================================== 4. what can't happen

test("no response from the connect route contains a credential", async () => {
  const w = await buildWorld();
  const logs = captureLogs();
  const bodies = [];
  try {
    const session = await sessionFor(w, w.userA);
    bodies.push(JSON.stringify((await connect(w, session, GOOD_A)).body));
    bodies.push(JSON.stringify((await connect(w, session, { ...GOOD_A, code: "FAKE-WRONG-CODE" })).body));
    bodies.push(JSON.stringify((await connect(w, session, { code: CODE_A })).body));
    bodies.push(JSON.stringify((await handleWhatsappTest(jsonCtx({ session, pathname: "/settings/whatsapp/test" }), w)).headers));
    bodies.push((await handleWhatsappSettingsGet(pageCtx({ session }), w)).html);
  } finally {
    logs.restore();
  }

  for (const body of bodies) {
    for (const secret of ALL_SECRETS) {
      assert.ok(!body.includes(secret), `a response carried ${secret.slice(0, 12)}…`);
    }
  }
  for (const line of logs.lines) {
    for (const secret of ALL_SECRETS) {
      assert.ok(!line.includes(secret), `a log line carried ${secret.slice(0, 12)}…`);
    }
  }
});

test("no credential is ever put in a redirect URL", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const ok = await connect(w, session, GOOD_A);
  const failed = await connect(w, session, { ...GOOD_A, code: "FAKE-WRONG-CODE" });
  const tested = await handleWhatsappTest(jsonCtx({ session, pathname: "/settings/whatsapp/test" }), w);

  for (const target of [ok.body.redirect, failed.body.redirect, tested.headers.Location]) {
    assert.ok(target.startsWith("/settings/whatsapp"), `unexpected redirect target ${target}`);
    for (const secret of ALL_SECRETS) assert.ok(!target.includes(secret));
  }
});

test("the business comes from the membership — a businessId in the body is not read", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await connect(w, session, { ...GOOD_A, businessId: w.bizB.id });
  assert.equal(res.body.ok, true);

  assert.equal((await w.integrations.forBusiness(w.bizA.id)).phoneNumberId, PHONE_A);
  assert.equal(await w.integrations.forBusiness(w.bizB.id), null, "the body's businessId redirected the integration");
});

test("one tenant cannot connect a number another tenant already holds", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);
  const before = await w.integrations.forBusiness(w.bizA.id);

  // B completes its own Meta flow but names A's number.
  const res = await connect(w, await sessionFor(w, w.userB), { code: CODE_B, phoneNumberId: PHONE_A, wabaId: WABA_A });

  assert.equal(res.status, 409);
  assert.equal(res.body.reason, SIGNUP_FAILURES.NUMBER_TAKEN);
  assert.deepEqual(await w.integrations.forBusiness(w.bizA.id), before, "A's integration was altered by B");
  assert.equal(await w.integrations.forBusiness(w.bizB.id), null);
});

test("a token that cannot prove it owns the number does not reach CONNECTED", async () => {
  const w = await buildWorld();
  // B's genuine token, pointed at B's own WABA but A's number.
  const res = await connect(w, await sessionFor(w, w.userB), { code: CODE_B, phoneNumberId: PHONE_B, wabaId: WABA_A });

  assert.equal(res.body.ok, false);
  const stored = await w.integrations.forBusiness(w.bizB.id);
  assert.equal(integrationState(stored), "ERROR");
  assert.equal(stored.lastError, FAILURE_REASONS.WABA_MISMATCH);
  assert.equal(stored.lastVerifiedAt, null, "an unverified connection claimed a verification time");
});

test("unauthenticated and under-privileged callers cannot connect anything", async () => {
  const w = await buildWorld();

  const anon = await connect(w, undefined, GOOD_A);
  assert.equal(anon.status, 401);

  const staff = await connect(w, await staffSessionFor(w), GOOD_A);
  assert.equal(staff.status, 403);

  assert.equal(await w.integrations.forBusiness(w.bizA.id), null, "a refused caller still stored an integration");
});

test("a signed-out customer following a Connect WhatsApp link lands on a page that exists", async () => {
  const w = await buildWorld();

  // The trap this pins: GET /login is not a route (login is POST-only), so
  // redirecting there gave a signed-out visitor a bare 404 instead of the
  // sign-in form — on the very link this product now puts in front of
  // every new customer.
  const { dispatch } = await import("../routes/router.mjs");
  for (const handler of [handleWhatsappSettingsGet, handleWhatsappTest]) {
    const res = await handler({
      method: "GET", pathname: "/settings/whatsapp",
      query: new URLSearchParams(), headers: {}, rawBody: Buffer.alloc(0),
    }, w);

    assert.equal(res.status, 302);
    const target = res.headers.Location;
    assert.notEqual(target, "/login", "redirected to a route that does not exist");

    const served = await dispatch({
      method: "GET", pathname: target,
      query: new URLSearchParams(), headers: {}, rawBody: Buffer.alloc(0),
    }, w);
    assert.ok(served, `${target} is not routable — a signed-out customer would see a 404`);
    assert.equal(served.status, 200);
    assert.match(served.html, /Sign in/);
  }
});

test("a deployment with no Embedded Signup configured refuses the route rather than half-completing", async () => {
  const w = await buildWorld({ signupEnv: {} });
  const res = await connect(w, await sessionFor(w, w.userA), GOOD_A);

  assert.equal(res.status, 503);
  assert.equal(res.body.reason, SIGNUP_FAILURES.NOT_CONFIGURED);
  assert.equal(await w.integrations.forBusiness(w.bizA.id), null);
});

// ============================================== 5. failures, told plainly

test("every failure is reported as one of our sentences, never a Meta error", async () => {
  const w = await buildWorld({ meta: honestMeta({ failExchange: true }) });
  const session = await sessionFor(w, w.userA);

  const cases = [
    [{ phoneNumberId: PHONE_A, wabaId: WABA_A }, SIGNUP_FAILURES.MISSING_CODE],
    [{ code: CODE_A }, SIGNUP_FAILURES.MISSING_ASSETS],
    [{ code: CODE_A, phoneNumberId: PHONE_A }, SIGNUP_FAILURES.MISSING_ASSETS],
    [GOOD_A, SIGNUP_FAILURES.EXCHANGE_FAILED],
  ];

  for (const [body, expected] of cases) {
    const res = await connect(w, session, body);
    assert.equal(res.body.reason, expected);
    assert.equal(res.body.error, signupMessage(expected));
    assert.ok(!res.body.error.includes("Invalid verification code format"), "Meta's own error text reached the customer");
    assert.ok(!res.body.error.includes("OAuth"));
  }

  assert.equal(await w.integrations.forBusiness(w.bizA.id), null);
});

test("a failed flow comes back to a page offering both Try again and Advanced setup", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  const { html } = await handleWhatsappSettingsGet(
    pageCtx({ session, query: { e: SIGNUP_FAILURES.MISSING_ASSETS } }), w
  );

  assert.match(html, /WhatsApp connection wasn't completed/);
  // The failure sentence is rendered escaped (an apostrophe becomes &#39;).
  // Matching the raw text used to pass only because the same sentence also
  // sat unescaped in the inline script, which proved nothing about the banner.
  assert.match(html, /We couldn(?:'|&#39;)t find a WhatsApp Business number for this account/);
  assert.match(html, /Try again/);
  assert.match(html, /Advanced setup/);
});

test("a crafted ?e= can only produce a sentence this codebase already contains", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  const { html } = await handleWhatsappSettingsGet(
    pageCtx({ session, query: { e: "<script>alert(1)</script>" } }), w
  );

  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /WhatsApp connection wasn't completed/);
});

// ================================================= 6. testing afterwards

test("Test Connection re-proves the stored credentials without the customer re-entering them", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  await connect(w, session, GOOD_A);

  const before = w.meta.calls.length;
  const res = await handleWhatsappTest(jsonCtx({ session, pathname: "/settings/whatsapp/test" }), w);

  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/settings/whatsapp?v=ok");
  assert.ok(w.meta.calls.length > before, "Test Connection asked Meta nothing");
  assert.equal(integrationState(await w.integrations.forBusiness(w.bizA.id)), "CONNECTED");
});

test("a connection Meta later rejects drops out of CONNECTED when tested", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  await connect(w, session, GOOD_A);

  // The customer revokes our access at Meta: the same stored token stops working.
  w.metaVerifier = createMetaVerifier({
    fetchImpl: fakeGraph({ numbers: {}, wabas: {}, validTokens: [] }).fetchImpl,
  });

  const res = await handleWhatsappTest(jsonCtx({ session, pathname: "/settings/whatsapp/test" }), w);
  assert.equal(res.headers.Location, `/settings/whatsapp?v=${FAILURE_REASONS.INVALID_CREDENTIALS}`);

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(integrationState(stored), "ERROR");
  // The recorded verification time survives: it says when it was last
  // genuinely proven, and a later failure does not unmake that.
  assert.ok(stored.lastVerifiedAt);
});

test("STAFF cannot trigger a test, and nothing changes when they try", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);
  const before = await w.integrations.forBusiness(w.bizA.id);

  const res = await handleWhatsappTest(jsonCtx({ session: await staffSessionFor(w), pathname: "/settings/whatsapp/test" }), w);
  assert.equal(res.status, 302);
  assert.deepEqual(await w.integrations.forBusiness(w.bizA.id), before);
});

// ====================================== 7. the rest of the system, after

test("an inbound message on a number connected this way routes to that business and no other", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);
  await connect(w, await sessionFor(w, w.userB), { code: CODE_B, phoneNumberId: PHONE_B, wabaId: WABA_B });

  const { result, calls } = await deliver(w, PHONE_A, "AC not cooling in Whitefield");
  assert.equal(result.status, 200);

  const { scopedToBusiness } = await import("../lib/store.redis.mjs");
  const convA = await scopedToBusiness(w.store, w.bizA.id).getConversation(CUSTOMER);
  const convB = await scopedToBusiness(w.store, w.bizB.id).getConversation(CUSTOMER);

  assert.ok(convA, "the message did not reach the business that owns the number");
  assert.equal(convB, null, "the message leaked into another tenant");

  // And the reply went out on A's own credentials.
  assert.ok(calls.length > 0, "no reply was sent");
  for (const call of calls) {
    assert.ok(call.url.includes(PHONE_A), `A replied via ${call.url}`);
    assert.equal(call.authorization, `Bearer ${TOKEN_A}`, "A replied on another tenant's token");
  }
});

test("an inbound message on an unknown number is dropped, not filed under someone", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);

  const { result, calls } = await deliver(w, "999999999999999", "hello?");

  // Meta still gets its 200 — retrying an unattributable event forever
  // helps nobody — but nothing was written and nothing was sent.
  assert.equal(result.status, 200);
  assert.equal(calls.length, 0, "an unknown number drew a reply from someone's credentials");

  const { scopedToBusiness } = await import("../lib/store.redis.mjs");
  for (const id of ["default", w.bizA.id, w.bizB.id]) {
    assert.equal(
      await scopedToBusiness(w.store, id).getConversation(CUSTOMER), null,
      `an unknown number created a conversation under ${id}`
    );
  }
});

test("a business sends on its own connected credentials, never another's", async () => {
  const w = await buildWorld();
  await connect(w, await sessionFor(w, w.userA), GOOD_A);
  await connect(w, await sessionFor(w, w.userB), { code: CODE_B, phoneNumberId: PHONE_B, wabaId: WABA_B });

  const { clientForBusiness } = await import("../lib/outbound.mjs");
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options.headers?.Authorization ?? "" });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.X" }] }) };
  };

  try {
    await (await clientForBusiness(w.bizA.id, w)).sendText(CUSTOMER, "from A");
    await (await clientForBusiness(w.bizB.id, w)).sendText(CUSTOMER, "from B");
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(calls[0].url.includes(PHONE_A) && calls[0].authorization === `Bearer ${TOKEN_A}`);
  assert.ok(calls[1].url.includes(PHONE_B) && calls[1].authorization === `Bearer ${TOKEN_B}`);
});

test("the manual Advanced form still works, and still cannot be believed without Meta", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await handleWhatsappSettingsPost({
    method: "POST", pathname: "/settings/whatsapp",
    query: new URLSearchParams(), headers: { cookie: `${COOKIE_NAME}=${session}` },
    rawBody: Buffer.from(new URLSearchParams({
      phoneNumberId: PHONE_A, wabaId: WABA_A, accessToken: TOKEN_A, displayPhoneNumber: "+91 98765 00001",
    }).toString()),
  }, w);

  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/settings/whatsapp?v=ok");
  assert.equal(integrationState(await w.integrations.forBusiness(w.bizA.id)), "CONNECTED");
});

// ================================================= 8. what the owner sees

test("the dashboard reports the connection in both directions", async () => {
  const w = await buildWorld();
  const actor = { businessId: w.bizA.id, role: "OWNER" };

  const off = overviewPage({
    business: w.bizA, actor, leads: [], whatsappStatus: "NOT_CONNECTED",
    onboarding: onboardingStatus(w.bizA, { connection: "NOT_CONNECTED" }),
  });
  assert.match(off, /WhatsApp Setup Required/);
  assert.match(off, /Connect WhatsApp to start automatically following up with missed calls/);

  const on = overviewPage({
    business: w.bizA, actor, leads: [], whatsappStatus: "CONNECTED",
    onboarding: onboardingStatus(w.bizA, { connection: "CONNECTED" }),
  });
  assert.match(on, /WhatsApp Connected/);
  assert.match(on, /Your missed-call follow-up is active/);
  assert.match(on, /Manage WhatsApp/);
});

test("the setup checklist reports real state, step by step", async () => {
  const w = await buildWorld();
  const actor = { businessId: w.bizA.id, role: "OWNER" };

  const early = overviewPage({
    business: { ...w.bizA, services: [], areas: [] }, actor, leads: [], whatsappStatus: "NOT_CONNECTED",
    onboarding: onboardingStatus({ ...w.bizA, services: [], areas: [] }, { connection: "NOT_CONNECTED" }),
  });
  assert.match(early, /Get your business ready/);
  for (const step of ["Create your business", "Add services", "Add service areas", "Connect WhatsApp", "Test your first missed call"]) {
    assert.ok(early.includes(step), `the checklist lost "${step}"`);
  }
  assert.match(early, /1 of 5 done/);

  // Connected, but no lead has ever arrived: the last step stays open and
  // the call to action becomes testing rather than connecting.
  const connected = overviewPage({
    business: w.bizA, actor, leads: [], whatsappStatus: "CONNECTED",
    onboarding: onboardingStatus(w.bizA, { connection: "CONNECTED" }),
  });
  assert.match(connected, /4 of 5 done/);
  assert.match(connected, /Test WhatsApp/);

  // A real lead finishes it, and the checklist disappears.
  const done = overviewPage({
    business: w.bizA, actor, whatsappStatus: "CONNECTED",
    leads: [{ id: "l1", status: "new", createdAt: new Date().toISOString(), name: "Ravi" }],
    onboarding: onboardingStatus(w.bizA, { connection: "CONNECTED" }),
  });
  assert.ok(!done.includes("Get your business ready"), "the checklist outlived its usefulness");
});

test("the success screen shows the connected number and offers a test, with no identifiers", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  await connect(w, session, GOOD_A);

  const { html } = await handleWhatsappSettingsGet(pageCtx({ session }), w);
  const main = html.slice(0, html.indexOf("<details"));

  assert.match(main, /WhatsApp Connected/);
  assert.match(main, /Your WhatsApp Business number is ready/);
  assert.match(main, /\+91 98765 00001/);
  assert.match(main, /Test Connection/);
  assert.match(main, /Continue to Dashboard/);
  // The raw ids belong to the technical section, not to this screen.
  assert.ok(!main.includes(PHONE_A), "a phone number id was shown to the customer");
  assert.ok(!main.includes(WABA_A), "a WABA id was shown to the customer");
});
