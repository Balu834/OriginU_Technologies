/**
 * The UNOFFICIAL QR-code WhatsApp connection, app side.
 *
 * The gateway is faked (it has its own tests in qr-gateway/test). What is
 * checked here is how the app treats a QR business: who it answers, what
 * it sends where, how a link is started and ended, and what the settings
 * page says about it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { createAccountService } from "../lib/users.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME } from "../lib/auth.mjs";
import { clientForBusiness, ownerAlertClientForBusiness } from "../lib/outbound.mjs";
import {
  qrConnectConfig, createQrWhatsAppClient, renderTemplateText, qrShouldReply, QR_REPLY_WINDOW_MS,
} from "../lib/qrGateway.mjs";
import { signQrRequest, QR_SIGNATURE_HEADER } from "../lib/qrSigning.mjs";
import { handleQrEvent, qrPendingKey, qrErrorKey } from "../routes/qrEvents.mjs";
import { handleQrStart, handleQrStatus, handleQrLogout } from "../routes/qrConnect.mjs";
import { reportMissedCall } from "../routes/missedCall.mjs";
import { handleWhatsappSettingsGet } from "../routes/accounts.mjs";
import { handleWhatsappTest, testFailureMarker } from "../routes/whatsappConnect.mjs";
import { whatsappSettingsPage } from "../lib/settingsViews.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const SECRET = "q".repeat(40);
const OWNER_PHONE = "+911111111111";
const QR_PHONE = "+919000000001";
const CALLER = "+917000000001";
const STRANGER = "+917000000099";

function fakeGateway() {
  let n = 0;
  const gw = {
    calls: [],
    sent: [],
    liveState: "connected",
    sendResult: null,
    async start(businessId, opts) { gw.calls.push(["start", businessId, opts]); return { ok: true, status: 200, body: { ok: true } }; },
    async status(businessId) {
      gw.calls.push(["status", businessId]);
      return { ok: true, status: 200, body: { ok: true, status: { state: gw.liveState, qrDataUrl: "data:image/png;base64,AAAA", pairingCode: null } } };
    },
    async send(businessId, to, text) {
      gw.calls.push(["send", businessId, to]);
      if (gw.sendResult) return gw.sendResult;
      gw.sent.push({ businessId, to, text });
      return { ok: true, status: 200, body: { ok: true, id: `QRMSG${++n}` } };
    },
    async logout(businessId) { gw.calls.push(["logout", businessId]); return { ok: true, status: 200, body: { ok: true } }; },
  };
  return gw;
}

async function world({ enabled = true, official = true } = {}) {
  const store = createStore(null);
  const config = {
    INTEGRATION_ENCRYPTION_KEY: "c".repeat(64),
    QR_CONNECT_ENABLED: enabled,
    QR_GATEWAY_URL: "https://gateway.example",
    QR_GATEWAY_SECRET: SECRET,
    META_ACCESS_TOKEN: official ? "official-token" : "",
    META_PHONE_NUMBER_ID: official ? "official-number-id" : "",
    WHATSAPP_MISSED_CALL_TEMPLATE: "missed_call_immediate",
    WHATSAPP_TEMPLATE_LANGUAGE: "en",
  };
  const accounts = createAccountService(store);
  const integrations = createIntegrationService(store, config);
  const owner = await accounts.signUp({ email: "qr-owner@example.test", password: "qr-owner-password" });
  const other = await accounts.signUp({ email: "qr-other@example.test", password: "qr-other-password" });
  const biz = businessRecord({ id: "qbiz", name: "Quick Electrical", ownerName: "Quasim", ownerWhatsApp: OWNER_PHONE });
  const bizOther = businessRecord({ id: "qbiz-other", name: "Other Plumbing", ownerName: "Om", ownerWhatsApp: "+912222222222" });
  await accounts.createBusinessFor(owner, biz);
  await accounts.createBusinessFor(other, bizOther);

  const w = {
    store, config, accounts, integrations, templates,
    businesses: await loadBusinessRegistry(store, config),
    wa: createFakeWa({ ownerAlertApproved: true }), // MissedCall's official number
    qrGateway: fakeGateway(),
    owner, other, biz, bizOther,
  };
  return w;
}

async function sessionFor(w, user = w.owner) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

function eventCtx(event, secret = SECRET) {
  const rawBody = Buffer.from(JSON.stringify(event));
  return { method: "POST", pathname: "/qr/events", rawBody, headers: { [QR_SIGNATURE_HEADER]: signQrRequest(rawBody, secret) } };
}

function formCtx(pathname, session, form = {}) {
  return {
    method: "POST", pathname, query: new URLSearchParams(),
    headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
    rawBody: Buffer.from(new URLSearchParams(form).toString()),
  };
}

function getCtx(pathname, session, query = {}) {
  return {
    method: "GET", pathname, query: new URLSearchParams(query),
    headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
    rawBody: Buffer.alloc(0),
  };
}

/** Links the business on the QR route the way the real flow does. */
async function linked(w) {
  await w.store.saveFlag(qrPendingKey(w.biz.id), { at: new Date().toISOString(), acknowledgement: { userId: w.owner.id } }, 900);
  const res = await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "connected", phone: QR_PHONE }), w);
  assert.equal(res.body.stop, undefined, "the link should be accepted");
  return w.integrations.forBusiness(w.biz.id);
}

const message = (w, from, text, id) =>
  handleQrEvent(eventCtx({ businessId: w.biz.id, type: "message", from, text, messageType: "text", messageId: id }), w);

// ---------------------------------------------------------------- config

test("QR is offered only with the flag on and a gateway, key and long secret set", () => {
  const base = { INTEGRATION_ENCRYPTION_KEY: "c".repeat(64), QR_GATEWAY_URL: "https://g.example", QR_GATEWAY_SECRET: SECRET };
  assert.equal(qrConnectConfig({}).available, false);
  assert.equal(qrConnectConfig(base).available, false, "flag off");
  assert.equal(qrConnectConfig(base).wired, true, "existing QR businesses keep running with the flag off");
  assert.equal(qrConnectConfig({ ...base, QR_CONNECT_ENABLED: true }).available, true);
  assert.equal(qrConnectConfig({ ...base, QR_CONNECT_ENABLED: true, QR_GATEWAY_SECRET: "short" }).available, false);
  assert.equal(qrConnectConfig({ ...base, QR_CONNECT_ENABLED: true, INTEGRATION_ENCRYPTION_KEY: "" }).available, false);
});

// ---------------------------------------------------------------- client

test("templates become plain text on this route", async () => {
  assert.equal(
    renderTemplateText(templates, "missed_call_immediate", { business_name: "Quick Electrical", owner_name: "Quasim" }),
    "Sorry we missed your call — this is Quick Electrical. Reply here with what you need and your area, and Quasim will call you straight back."
  );
  const gw = fakeGateway();
  const client = createQrWhatsAppClient({ gateway: gw, businessId: "qbiz", templates });
  const sent = await client.sendTemplate(CALLER, "missed_call_immediate", "en", { business_name: "Q", owner_name: "O" });
  assert.equal(sent.ok, true);
  assert.equal(sent.body.messages[0].id, "QRMSG1");
  assert.match(gw.sent[0].text, /this is Q\. .*O will call you/);

  const unknown = await client.sendTemplate(CALLER, "no_such_template", "en", {});
  assert.equal(unknown.ok, false);
  assert.equal(gw.sent.length, 1);
});

test("gateway failures read like the Meta failures the page already explains", async () => {
  const gw = fakeGateway();
  const client = createQrWhatsAppClient({ gateway: gw, businessId: "qbiz", templates });
  gw.sendResult = { ok: false, status: 422, body: { ok: false, code: "not_on_whatsapp" } };
  assert.equal(testFailureMarker((await client.sendText(CALLER, "x")).body.error.code), "notwa");
  gw.sendResult = { ok: false, status: 422, body: { ok: false, code: "not_connected" } };
  assert.equal(testFailureMarker((await client.sendText(CALLER, "x")).body.error.code), "qroffline");
});

// ---------------------------------------------------------------- who gets a reply

test("the bot answers only recent callers and mid-conversation customers", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const hour = 60 * 60 * 1000;
  const conv = (o) => ({ updatedAt: new Date(now - hour).toISOString(), completed: false, ...o });

  assert.equal(qrShouldReply(null, null, now), false, "never called");
  assert.equal(qrShouldReply(null, now - hour, now), true, "called an hour ago");
  assert.equal(qrShouldReply(null, now - QR_REPLY_WINDOW_MS - 1, now), false, "called three days ago");
  assert.equal(qrShouldReply(conv({}), now - 2 * hour, now), true, "part-way through the questions");
  assert.equal(qrShouldReply(conv({ completed: true }), now - 2 * hour, now), false, "lead done: quiet");
  assert.equal(qrShouldReply(conv({ completed: true }), now - 10 * 60 * 1000, now), true, "called again after the lead");
  assert.equal(qrShouldReply(conv({ ownerTookOverAt: new Date(now - 30 * 60 * 1000).toISOString() }), now - 2 * hour, now), false, "owner took over");
  assert.equal(qrShouldReply(conv({ ownerTookOverAt: new Date(now - 30 * 60 * 1000).toISOString() }), now - 60 * 1000, now), true, "called again after takeover");
});

// ---------------------------------------------------------------- linking

test("an unsigned or wrongly signed event is refused", async () => {
  const w = await world();
  const event = { businessId: w.biz.id, type: "connection", state: "connected", phone: QR_PHONE };
  assert.equal((await handleQrEvent({ rawBody: Buffer.from(JSON.stringify(event)), headers: {} }, w)).status, 403);
  assert.equal((await handleQrEvent(eventCtx(event, "x".repeat(40)), w)).status, 403);
  assert.equal(await w.integrations.forBusiness(w.biz.id), null);
});

test("a link nobody asked for is stopped, not recorded", async () => {
  const w = await world();
  const res = await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "connected", phone: QR_PHONE }), w);
  assert.equal(res.body.stop, true);
  assert.equal(await w.integrations.forBusiness(w.biz.id), null);
});

test("an unknown business is told to stop", async () => {
  const w = await world();
  const res = await message(w, CALLER, "hi", "X1");
  assert.equal(res.body.stop, true, "not on QR");
  const ghost = await handleQrEvent(eventCtx({ businessId: "nope", type: "message", from: CALLER, text: "hi" }), w);
  assert.equal(ghost.body.stop, true);
});

test("a requested link is recorded as a QR connection with the acknowledgement", async () => {
  const w = await world();
  const integration = await linked(w);
  assert.equal(integration.provider, "whatsapp_qr");
  assert.equal(integration.status, "CONNECTED");
  assert.equal(integration.phoneNumberId, "qr:919000000001");
  assert.equal(integration.displayPhoneNumber, QR_PHONE);
  assert.equal(integration.qrAcknowledgement.userId, w.owner.id);
  assert.equal(integration.accessTokenEncrypted, "", "no Meta token on this route");
  assert.equal(await w.store.getFlag(qrPendingKey(w.biz.id)), null);
});

test("a number another business already has is refused, and the page is told why", async () => {
  const w = await world();
  await w.integrations.registerQr({ businessId: w.bizOther.id, phone: QR_PHONE });
  await w.store.saveFlag(qrPendingKey(w.biz.id), { at: "x" }, 900);
  const res = await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "connected", phone: QR_PHONE }), w);
  assert.equal(res.body.stop, true);
  assert.equal(await w.store.getFlag(qrErrorKey(w.biz.id)), "claimed");
  assert.equal(await w.integrations.forBusiness(w.biz.id), null);
});

test("after a gateway restart the same number reconnects without a new request", async () => {
  const w = await world();
  const integration = await linked(w);
  await w.integrations.markVerificationFailed(integration, "whatsapp_disconnected");
  const res = await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "connected", phone: QR_PHONE }), w);
  assert.equal(res.body.stop, undefined);
  const again = await w.integrations.forBusiness(w.biz.id);
  assert.equal(again.status, "CONNECTED");
  assert.equal(again.qrAcknowledgement.userId, w.owner.id, "acknowledgement kept across reconnects");

  const swapped = await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "connected", phone: "+919000000002" }), w);
  assert.equal(swapped.body.stop, true, "a different number needs a fresh request");
});

test("logged out or blocked: the connection goes to ERROR and sends stop", async () => {
  const w = await world();
  await linked(w);
  await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "banned" }), w);
  const integration = await w.integrations.forBusiness(w.biz.id);
  assert.equal(integration.status, "ERROR");
  assert.equal(integration.lastError, "whatsapp_number_blocked");
  assert.equal(await clientForBusiness(w.biz.id, w), null, "a blocked number is not sent on");
  assert.equal((await message(w, CALLER, "hi", "M0")).body.ignored, "not_connected");
});

// ---------------------------------------------------------------- the conversation

test("missed call to lead on the owner's own number, with the alert from MissedCall's official number", async () => {
  const w = await world();
  await linked(w);

  const call = await reportMissedCall(w.biz, { callerNumber: CALLER }, w);
  assert.equal(call.status, 200);
  assert.equal(w.qrGateway.sent.length, 1);
  assert.equal(w.qrGateway.sent[0].to, CALLER);
  assert.match(w.qrGateway.sent[0].text, /Sorry we missed your call — this is Quick Electrical/);
  assert.equal(w.wa.sent.length, 0, "the official number sends nothing to customers");

  await message(w, CALLER, "AC not cooling", "M1");
  await message(w, CALLER, "Whitefield", "M2");
  await message(w, CALLER, "Ravi", "M3");
  await message(w, CALLER, "Need someone today", "M4");

  const toCaller = w.qrGateway.sent.filter((m) => m.to === CALLER);
  assert.equal(toCaller.length, 5, "template + three questions + confirmation, all from the owner's number");
  assert.equal(w.qrGateway.sent.some((m) => m.to === OWNER_PHONE), false, "no alert to the owner from their own number");

  const alert = w.wa.sent.find((m) => m.to === OWNER_PHONE);
  assert.ok(alert, "owner alert sent");
  assert.equal(alert.kind, "template");
  assert.equal(alert.templateName, "new_lead_alert");
  assert.equal(alert.bodyParams.business_name, "Quick Electrical");

  const [lead] = await scopedToBusiness(w.store, w.biz.id).listLeads();
  assert.equal(lead.name, "Ravi");
  assert.equal(lead.ownerNotified, true);
});

test("a message from someone who didn't call is ignored and not stored", async () => {
  const w = await world();
  await linked(w);
  const res = await message(w, STRANGER, "Happy birthday bro!", "P1");
  assert.equal(res.body.ignored, "not_a_caller");
  assert.equal(w.qrGateway.sent.length, 0);
  const tenant = scopedToBusiness(w.store, w.biz.id);
  assert.deepEqual(await tenant.listMessages(STRANGER), []);
  assert.equal(await tenant.getConversation(STRANGER), null);
  assert.equal(await tenant.hasProcessedMessage("qr:P1"), false);
});

test("once the owner replies from the phone, the bot stays out until the next call", async () => {
  const w = await world();
  await linked(w);
  await reportMissedCall(w.biz, { callerNumber: CALLER }, w);
  await message(w, CALLER, "AC not cooling", "M1");
  const before = w.qrGateway.sent.length;

  await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "owner_reply", to: CALLER }), w);
  const res = await message(w, CALLER, "Whitefield", "M2");
  assert.equal(res.body.ignored, "not_a_caller");
  assert.equal(w.qrGateway.sent.length, before);
});

test("a duplicate delivery of the same message is answered once", async () => {
  const w = await world();
  await linked(w);
  await reportMissedCall(w.biz, { callerNumber: CALLER }, w);
  await message(w, CALLER, "AC not cooling", "DUP");
  const after = w.qrGateway.sent.length;
  await message(w, CALLER, "AC not cooling", "DUP");
  assert.equal(w.qrGateway.sent.length, after);
});

test("delivery receipts update what we sent", async () => {
  const w = await world();
  await linked(w);
  await reportMissedCall(w.biz, { callerNumber: CALLER }, w);
  await message(w, CALLER, "AC not cooling", "M1");
  const tenant = scopedToBusiness(w.store, w.biz.id);
  const reply = (await tenant.listMessages(CALLER)).find((m) => m.direction === "outbound");
  await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "receipt", messageId: reply.messageId, status: "read" }), w);
  assert.equal((await tenant.findMessageByProviderId(reply.messageId)).deliveryStatus, "read");
});

test("owner alerts for QR businesses need the official number configured", async () => {
  const w = await world({ official: false });
  await linked(w);
  assert.equal(await ownerAlertClientForBusiness(w.biz.id, w), null);
  const withOfficial = await world();
  await linked(withOfficial);
  assert.equal(await ownerAlertClientForBusiness(withOfficial.biz.id, withOfficial), withOfficial.wa);
});

test("a business that moved to the official route tells the gateway to stop", async () => {
  const w = await world();
  await linked(w);
  await w.integrations.register({ businessId: w.biz.id, phoneNumberId: "meta-123", accessToken: "t", status: "CONNECTED" });
  assert.equal((await message(w, CALLER, "hi", "Z1")).body.stop, true);
});

// ---------------------------------------------------------------- settings routes

test("Start needs the risk box ticked, then asks the gateway", async () => {
  const w = await world();
  const session = await sessionFor(w);

  const noAck = await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { mode: "qr" }), w);
  assert.match(noAck.headers.Location, /q=ack/);
  assert.equal(w.qrGateway.calls.length, 0);

  const ok = await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { mode: "qr", ack: "yes" }), w);
  assert.match(ok.headers.Location, /q=started/);
  assert.deepEqual(w.qrGateway.calls[0], ["start", w.biz.id, { mode: "qr", phone: "" }]);
  const pending = await w.store.getFlag(qrPendingKey(w.biz.id));
  assert.equal(pending.acknowledgement.userId, w.owner.id);
});

test("code mode needs a real number", async () => {
  const w = await world();
  const session = await sessionFor(w);
  const bad = await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { mode: "code", phone: "abc", ack: "yes" }), w);
  assert.match(bad.headers.Location, /q=phone/);
  await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { mode: "code", phone: "9000000001", ack: "yes" }), w);
  assert.deepEqual(w.qrGateway.calls.at(-1), ["start", w.biz.id, { mode: "code", phone: QR_PHONE }]);
});

test("with the flag off, nobody new can start; a QR business can still reconnect", async () => {
  const w = await world({ enabled: false });
  const session = await sessionFor(w);
  const res = await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { ack: "yes" }), w);
  assert.match(res.headers.Location, /q=off/);
  assert.equal(w.qrGateway.calls.length, 0);

  await linked(w);
  const reconnect = await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { mode: "qr" }), w);
  assert.match(reconnect.headers.Location, /q=started/, "acknowledged before, no tick needed");
});

test("STAFF cannot start or log out a QR link", async () => {
  const w = await world();
  const staff = await w.accounts.signUp({ email: "qr-staff@example.test", password: "qr-staff-password" });
  await w.accounts.addMember({ businessId: w.biz.id, email: "qr-staff@example.test", role: "STAFF" });
  const session = await createSession(w.store, w.biz.id, { userId: staff.id });
  await handleQrStart(formCtx("/settings/whatsapp/qr/start", session, { ack: "yes" }), w);
  await handleQrLogout(formCtx("/settings/whatsapp/qr/logout", session), w);
  assert.equal(w.qrGateway.calls.length, 0);
});

test("status passes through only a PNG QR and our own sentences", async () => {
  const w = await world();
  const session = await sessionFor(w);
  w.qrGateway.liveState = "qr";
  const res = await handleQrStatus(getCtx("/settings/whatsapp/qr/status", session), w);
  assert.equal(res.body.state, "qr");
  assert.equal(res.body.qrDataUrl, "data:image/png;base64,AAAA");
  assert.match(res.body.message, /Linked devices/);

  w.qrGateway.status = async () => ({ ok: true, body: { status: { state: "<script>", qrDataUrl: "javascript:alert(1)" } } });
  const odd = await handleQrStatus(getCtx("/settings/whatsapp/qr/status", session), w);
  assert.equal(odd.body.state, "unreachable");
  assert.equal(odd.body.qrDataUrl, null);

  assert.equal((await handleQrStatus(getCtx("/settings/whatsapp/qr/status", null), w)).status, 401);
});

test("Log out unlinks on the gateway and frees the number", async () => {
  const w = await world();
  await linked(w);
  const session = await sessionFor(w);
  const res = await handleQrLogout(formCtx("/settings/whatsapp/qr/logout", session), w);
  assert.match(res.headers.Location, /q=loggedout/);
  assert.deepEqual(w.qrGateway.calls.at(-1), ["logout", w.biz.id]);
  const integration = await w.integrations.forBusiness(w.biz.id);
  assert.equal(integration.status, "NOT_CONNECTED");
  assert.equal(await w.integrations.byPhoneNumberId("qr:919000000001"), null);
  // ...so the gateway reconnecting it on its own is refused.
  const res2 = await handleQrEvent(eventCtx({ businessId: w.biz.id, type: "connection", state: "connected", phone: QR_PHONE }), w);
  assert.equal(res2.body.stop, true);
});

test("Test Connection asks the gateway, not Meta", async () => {
  const w = await world();
  await linked(w);
  const session = await sessionFor(w);
  const ok = await handleWhatsappTest(formCtx("/settings/whatsapp/test", session), w);
  assert.match(ok.headers.Location, /v=qrok/);
  w.qrGateway.liveState = "offline";
  const down = await handleWhatsappTest(formCtx("/settings/whatsapp/test", session), w);
  assert.match(down.headers.Location, /v=whatsapp_offline/);
  assert.equal((await w.integrations.forBusiness(w.biz.id)).status, "ERROR");
});

// ---------------------------------------------------------------- the page

test("flag off: the page has no QR option", async () => {
  const w = await world({ enabled: false });
  const res = await handleWhatsappSettingsGet(getCtx("/settings/whatsapp", await sessionFor(w)), w);
  assert.doesNotMatch(res.html, /QR code/);
});

test("flag on: the QR option shows the risks and the tick box, and never claims to be official", async () => {
  const w = await world();
  const res = await handleWhatsappSettingsGet(getCtx("/settings/whatsapp", await sessionFor(w)), w);
  const html = res.html;
  assert.match(html, /Connect by scanning a QR code \(unofficial\)/);
  assert.match(html, /not an official WhatsApp or Meta connection/);
  assert.match(html, /can ban your number without warning/);
  assert.match(html, /your real business number/);
  assert.match(html, /name="ack" value="yes" required/);

  const option = html.slice(html.indexOf('id="qr-option"'), html.indexOf("</details>", html.indexOf('id="qr-option"')));
  assert.doesNotMatch(option, /meta[- ]approved|approved by meta|verified by meta|securely connect/i);
});

test("a QR connection is shown as unofficial, with Reconnect and Log out and no template button", () => {
  const html = whatsappSettingsPage({
    business: { name: "Quick Electrical" },
    integration: { provider: "whatsapp_qr", displayPhoneNumber: QR_PHONE, status: "CONNECTED" },
    status: "CONNECTED",
    canManage: true,
    role: "OWNER",
    qr: { available: true },
  });
  assert.match(html, /Connected \(unofficial\)/);
  assert.match(html, /\/settings\/whatsapp\/qr\/logout/);
  assert.match(html, />Reconnect</);
  assert.doesNotMatch(html, /Create message templates/);
  assert.doesNotMatch(html, /Connect by scanning a QR code/, "not offered again while linked");
});

test("a disconnected QR link says why and offers Reconnect", () => {
  const html = whatsappSettingsPage({
    business: { name: "Quick Electrical" },
    integration: { provider: "whatsapp_qr", status: "ERROR", lastError: "whatsapp_logged_out" },
    status: "ERROR",
    canManage: true,
    qr: { available: true },
  });
  assert.match(html, /WhatsApp unlinked MissedCall from your phone/);
  assert.match(html, />Reconnect</);
  assert.doesNotMatch(html, /hasn't been confirmed by Meta/);
});

test("while linking, the page polls for the QR and writes none into the markup", () => {
  const html = whatsappSettingsPage({ status: "NOT_CONNECTED", canManage: true, qr: { available: true, polling: true } });
  assert.match(html, /id="qr-img"/);
  assert.match(html, /\/settings\/whatsapp\/qr\/status/);
  assert.doesNotMatch(html, /data:image\/png;base64,[A-Za-z0-9+/]{8,}/);
});

test("a business on the official route can't be switched to QR by a stray form", async () => {
  const w = await world();
  await w.integrations.register({ businessId: w.biz.id, phoneNumberId: "meta-123", accessToken: "t", status: "CONNECTED" });
  const res = await handleQrStart(formCtx("/settings/whatsapp/qr/start", await sessionFor(w), { ack: "yes" }), w);
  assert.match(res.headers.Location, /q=official/);
  assert.equal(w.qrGateway.calls.length, 0);
});
