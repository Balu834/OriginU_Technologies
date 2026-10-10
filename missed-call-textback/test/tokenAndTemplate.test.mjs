/**
 * Embedded Signup connections that keep working after day one.
 *
 * Two things a one-click connection needs beyond the click itself:
 *
 *   - the customer's own WABA must contain the missed-call template, or
 *     every send fails while the page says "Connected";
 *   - the 60-day token must be renewed before it lapses, and a lapsed one
 *     must be reported as lapsed rather than left looking healthy.
 *
 * Meta is mocked at fetch. All tokens are fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import {
  createIntegrationService, publicView, expiryFromSeconds, tokenExpired, tokenNeedsRefresh,
  TOKEN_REFRESH_WINDOW_DAYS,
} from "../lib/integrations.mjs";
import { createEmbeddedSignupClient, TEMPLATE_DEFINITIONS } from "../lib/embeddedSignup.mjs";
import { clientForBusiness } from "../lib/outbound.mjs";
import { whatsappSettingsPage } from "../lib/settingsViews.mjs";
import { generateEncryptionKey } from "../lib/crypto.mjs";
import templates from "../templates.json" with { type: "json" };

const DAY = 24 * 60 * 60 * 1000;
const OLD_TOKEN = "FAKE-OLD-TOKEN";
const NEW_TOKEN = "FAKE-NEW-TOKEN";
const SIXTY_DAYS = 60 * 24 * 60 * 60;

function graph(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method ?? "GET",
      token: (options.headers?.Authorization ?? "").replace("Bearer ", ""),
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    const [status, body] = handler(call);
    return { ok: status < 400, status, json: async () => body };
  };
  const client = createEmbeddedSignupClient({ appId: "APP", appSecret: "APPSECRET", fetchImpl });
  return { calls, client };
}

function service() {
  const store = createStore(null);
  const integrations = createIntegrationService(store, { INTEGRATION_ENCRYPTION_KEY: generateEncryptionKey() });
  return { store, integrations };
}

const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

// ------------------------------------------------------------- expiry maths

test("a token's expiry is recorded from Meta's expires_in, and absent when Meta gives none", async () => {
  const { client } = graph(() => [200, { access_token: NEW_TOKEN, expires_in: SIXTY_DAYS }]);
  const exchanged = await client.exchangeCode("code");
  assert.equal(exchanged.expiresIn, SIXTY_DAYS);

  const at = Date.parse(expiryFromSeconds(exchanged.expiresIn, 0));
  assert.equal(at, SIXTY_DAYS * 1000);

  const { client: forever } = graph(() => [200, { access_token: NEW_TOKEN }]);
  assert.equal((await forever.exchangeCode("code")).expiresIn, null);
  assert.equal(expiryFromSeconds(null), null);
});

test("refresh is due only inside the window, and never for an expired or non-expiring token", () => {
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: inDays(TOKEN_REFRESH_WINDOW_DAYS + 5) }), false);
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: inDays(TOKEN_REFRESH_WINDOW_DAYS - 1) }), true);
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: inDays(-1) }), false, "an expired token cannot be refreshed");
  assert.equal(tokenNeedsRefresh({ tokenExpiresAt: null }), false, "manual tokens do not expire");

  assert.equal(tokenExpired({ tokenExpiresAt: inDays(-1) }), true);
  assert.equal(tokenExpired({ tokenExpiresAt: inDays(1) }), false);
  assert.equal(tokenExpired({ tokenExpiresAt: null }), false);
});

// ------------------------------------------------------------------ refresh

test("refreshToken exchanges the current token for a new 60-day one", async () => {
  const { client, calls } = graph(() => [200, { access_token: NEW_TOKEN, expires_in: SIXTY_DAYS }]);
  const res = await client.refreshToken(OLD_TOKEN);

  assert.deepEqual(res, { ok: true, accessToken: NEW_TOKEN, expiresIn: SIXTY_DAYS });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname.endsWith("/oauth/access_token"), true);
  assert.equal(url.searchParams.get("grant_type"), "fb_exchange_token");
  assert.equal(url.searchParams.get("fb_exchange_token"), OLD_TOKEN);
  assert.equal(url.searchParams.get("set_token_expires_in_60_days"), "true");
});

test("a rejected refresh reports failure and carries no token", async () => {
  const { client } = graph(() => [400, { error: { code: 190, message: "expired" } }]);
  const res = await client.refreshToken(OLD_TOKEN);
  assert.equal(res.ok, false);
  assert.equal(JSON.stringify(res).includes(OLD_TOKEN), false);
});

test("a send inside the refresh window renews the stored token and sends with the new one", async () => {
  const { integrations } = service();
  await integrations.register({
    businessId: "acme", phoneNumberId: "111", wabaId: "W", accessToken: OLD_TOKEN, tokenExpiresAt: inDays(3),
  });
  const { client, calls } = graph(() => [200, { access_token: NEW_TOKEN, expires_in: SIXTY_DAYS }]);

  const wa = await clientForBusiness("acme", { integrations, embeddedSignup: client });
  assert.ok(wa, "the business can still send");
  assert.equal(calls.length, 1, "exactly one refresh call");

  const stored = await integrations.forBusiness("acme");
  assert.equal(integrations.secretsOf(stored).accessToken, NEW_TOKEN);
  assert.ok(Date.parse(stored.tokenExpiresAt) > Date.now() + 50 * DAY);
  assert.equal(stored.phoneNumberId, "111", "refreshing changes the token and nothing else");
});

test("a token far from expiry, or with no expiry, is not refreshed", async () => {
  const { integrations } = service();
  await integrations.register({ businessId: "far", phoneNumberId: "1", accessToken: OLD_TOKEN, tokenExpiresAt: inDays(40) });
  await integrations.register({ businessId: "manual", phoneNumberId: "2", accessToken: OLD_TOKEN });
  const { client, calls } = graph(() => [200, { access_token: NEW_TOKEN, expires_in: SIXTY_DAYS }]);

  assert.ok(await clientForBusiness("far", { integrations, embeddedSignup: client }));
  assert.ok(await clientForBusiness("manual", { integrations, embeddedSignup: client }));
  assert.equal(calls.length, 0);
});

test("a failed refresh never blocks a send that the current token can still make", async () => {
  const { integrations } = service();
  await integrations.register({ businessId: "acme", phoneNumberId: "111", accessToken: OLD_TOKEN, tokenExpiresAt: inDays(2) });
  const { client } = graph(() => [500, { error: { code: 2, message: "temporary" } }]);

  assert.ok(await clientForBusiness("acme", { integrations, embeddedSignup: client }));
  const stored = await integrations.forBusiness("acme");
  assert.equal(integrations.secretsOf(stored).accessToken, OLD_TOKEN, "the working token is kept");
});

test("an expired token refuses to send instead of borrowing or pretending", async () => {
  const { integrations } = service();
  await integrations.register({ businessId: "acme", phoneNumberId: "111", accessToken: OLD_TOKEN, tokenExpiresAt: inDays(-1) });
  const { client, calls } = graph(() => [200, { access_token: NEW_TOKEN, expires_in: SIXTY_DAYS }]);

  assert.equal(await clientForBusiness("acme", { integrations, embeddedSignup: client, wa: { shared: true } }), null);
  assert.equal(calls.length, 0, "an expired token is not sent to Meta for refresh");
});

// ----------------------------------------------------------------- template

test("the template created in a customer's WABA says exactly what templates.json says", () => {
  for (const name of ["missed_call_immediate", "missed_call_after_hours"]) {
    assert.equal(TEMPLATE_DEFINITIONS[name].body, templates[name].body, name);
    assert.equal(TEMPLATE_DEFINITIONS[name].category, templates[name].category, name);
  }
});

test("ensureTemplate submits a NAMED utility template with an example for every variable", async () => {
  const { client, calls } = graph(() => [200, { id: "1", status: "PENDING" }]);
  const res = await client.ensureTemplate("WABA9", NEW_TOKEN, { name: "missed_call_immediate", language: "en" });

  assert.deepEqual(res, { ok: true, status: "PENDING" });
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/WABA9/message_templates"));
  assert.equal(call.token, NEW_TOKEN);
  assert.equal(call.body.category, "UTILITY");
  assert.equal(call.body.parameter_format, "NAMED");
  assert.equal(call.body.language, "en");
  const body = call.body.components[0];
  const named = body.example.body_text_named_params.map((p) => p.param_name).sort();
  const used = [...body.text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, used, "every variable in the text has an example, and no extras");
});

test("a template that already exists counts as success", async () => {
  const { client } = graph(() => [400, { error: { code: 100, error_subcode: 2388024, message: "Content in this language already exists" } }]);
  assert.deepEqual(await client.ensureTemplate("W", NEW_TOKEN, { name: "missed_call_immediate" }), { ok: true, existing: true });
});

test("a template this codebase does not know the wording of is skipped, not invented", async () => {
  const { client, calls } = graph(() => [200, {}]);
  const res = await client.ensureTemplate("W", NEW_TOKEN, { name: "some_custom_template" });
  assert.equal(res.skipped, true);
  assert.equal(calls.length, 0);
});

test("a rejected template is reported as failed without throwing", async () => {
  const { client } = graph(() => [400, { error: { code: 100, error_subcode: 1, message: "Invalid parameter" } }]);
  const res = await client.ensureTemplate("W", NEW_TOKEN, { name: "missed_call_immediate" });
  assert.equal(res.ok, false);
});

// ------------------------------------------------------------- what is shown

test("publicView reports the expiry and the template request, and still no credential", async () => {
  const { integrations } = service();
  let integration = await integrations.register({
    businessId: "acme", phoneNumberId: "111", accessToken: OLD_TOKEN, tokenExpiresAt: inDays(30),
  });
  integration = await integrations.noteTemplate(integration, { name: "missed_call_immediate", state: "submitted" });

  const view = publicView(integration);
  assert.equal(view.connectionExpiresAt, integration.tokenExpiresAt);
  assert.equal(view.template.state, "submitted");
  assert.equal(JSON.stringify(view).includes(OLD_TOKEN), false);
});

test("the settings page tells the owner the template is awaiting Meta, not that it works", () => {
  const html = whatsappSettingsPage({
    business: { name: "Acme" }, status: "CONNECTED", canManage: true,
    integration: { displayPhoneNumber: "+91 90000 00000", connectionExpiresAt: inDays(30), template: { state: "submitted" } },
  }).toString();
  assert.match(html, /Sent to Meta for approval/);
  assert.match(html, /Renews by/);
  assert.doesNotMatch(html, /connection has expired/);
});

test("an expired connection stops showing a green tick and offers Connect WhatsApp again", () => {
  const html = whatsappSettingsPage({
    business: { name: "Acme" }, status: "CONNECTED", canManage: true,
    signup: { available: true, appId: "APP", configId: "CFG", graphVersion: "v23.0" },
    integration: { displayPhoneNumber: "+91 90000 00000", connectionExpiresAt: inDays(-2) },
  }).toString();
  assert.match(html, /connection has expired/);
  assert.match(html, /id="connect-whatsapp"/);
  assert.doesNotMatch(html, /✓ WhatsApp Connected/);
});

test("the signup page accepts Meta's messages from any facebook.com host, and nothing else", () => {
  const html = String(whatsappSettingsPage({
    business: { name: "Acme" }, status: "NOT_CONNECTED", canManage: true,
    signup: { available: true, appId: "APP", configId: "CFG", graphVersion: "v23.0" },
  }));
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js), "the inline script must parse");
  const ORIGIN = eval(js.match(/var META_ORIGIN = (\/.*\/);/)[1]);
  for (const ok of ["https://www.facebook.com", "https://business.facebook.com", "https://web.facebook.com"]) {
    assert.equal(ORIGIN.test(ok), true, ok);
  }
  for (const bad of ["https://evil.com", "https://facebook.com.evil.com", "http://www.facebook.com", "https://notfacebook.com"]) {
    assert.equal(ORIGIN.test(bad), false, bad);
  }
});
