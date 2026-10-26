/**
 * The QR-code ("linked device") WhatsApp connection, app side.
 *
 * UNOFFICIAL. A business on this route has MissedCall logged in to its own
 * WhatsApp as a linked device, through the gateway in qr-gateway/. It is
 * against WhatsApp's terms and the number can be banned. It is not, and
 * must never be described as, an official or Meta-approved connection.
 *
 * This module has three parts:
 *
 * 1. `qrConnectConfig` decides whether the settings page may offer it.
 * 2. `createQrGatewayClient` talks to the gateway, signed.
 * 3. `createQrWhatsAppClient` looks exactly like the Meta client
 *    (sendText / sendTemplate, same result shape), so the missed-call,
 *    conversation and test-message code needs no second path.
 *
 * There are no templates on this route. `sendTemplate` renders the
 * template's wording from templates.json and sends it as plain text, and
 * plain text has no 24-hour window here.
 */
import crypto from "node:crypto";
import { signQrRequest, QR_SIGNATURE_HEADER } from "./qrSigning.mjs";
import { isValidEncryptionKey } from "./crypto.mjs";

export const QR_PROVIDER = "whatsapp_qr";

/** How long after a missed call the bot will answer that person on the owner's number. */
export const QR_REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Whether QR can be offered here, and whether existing QR businesses can still run. */
export function qrConnectConfig(config = {}) {
  const url = String(config.QR_GATEWAY_URL ?? "").replace(/\/$/, "");
  const secret = String(config.QR_GATEWAY_SECRET ?? "");
  const wired = Boolean(/^https?:\/\//.test(url) && secret.length >= 32 && isValidEncryptionKey(config.INTEGRATION_ENCRYPTION_KEY));
  return { wired, available: Boolean(config.QR_CONNECT_ENABLED) && wired, url, secret };
}

/** A gateway client, or null when this deployment has no gateway. */
export function qrGatewayFromConfig(config, { fetchImpl = fetch } = {}) {
  const qr = qrConnectConfig(config);
  return qr.wired ? createQrGatewayClient({ url: qr.url, secret: qr.secret, fetchImpl }) : null;
}

export function createQrGatewayClient({ url, secret, fetchImpl = fetch, timeoutMs = 25_000 }) {
  async function call(action, payload) {
    const body = JSON.stringify({ requestId: crypto.randomUUID(), ...payload });
    try {
      const res = await fetchImpl(`${url}/sessions/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [QR_SIGNATURE_HEADER]: signQrRequest(body, secret) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok && json?.ok !== false, status: res.status, body: json ?? {} };
    } catch {
      return { ok: false, status: 0, body: { code: "gateway_unreachable" } };
    }
  }

  return {
    start: (businessId, { mode = "qr", phone = "" } = {}) => call("start", { businessId, mode, phone }),
    status: (businessId) => call("status", { businessId }),
    send: (businessId, to, text) => call("send", { businessId, to, text }),
    logout: (businessId) => call("logout", { businessId }),
  };
}

/**
 * Gateway failure codes as the Meta error codes the rest of the app
 * already explains, so "that number isn't on WhatsApp" reads the same on
 * both routes. Codes with no Meta twin keep a qr_ name.
 */
const GATEWAY_TO_META = {
  not_on_whatsapp: 131026,
  rate_limited: 131056,
};

/** Fills a templates.json body ("Hi {{business_name}}") with named values. */
export function renderTemplateText(templates, name, params = {}) {
  const body = templates?.[name]?.body;
  if (typeof body !== "string") return null;
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => String(params[key] ?? "").trim());
}

export function createQrWhatsAppClient({ gateway, businessId, templates }) {
  async function sendText(to, body) {
    const result = await gateway.send(businessId, to, body);
    if (result.ok && result.body?.id) {
      return { ok: true, status: 200, body: { messages: [{ id: result.body.id }] } };
    }
    const code = result.body?.code ?? "send_failed";
    return {
      ok: false,
      status: result.status || 0,
      body: { error: { code: GATEWAY_TO_META[code] ?? `qr_${code}`, message: `QR gateway: ${code}` } },
    };
  }

  return {
    sendText,
    async sendTemplate(to, templateName, _languageCode, bodyParams = {}) {
      const text = renderTemplateText(templates, templateName, bodyParams);
      if (!text) {
        return { ok: false, status: 0, body: { error: { code: "qr_no_template_text", message: `no wording for ${templateName}` } } };
      }
      return sendText(to, text);
    },
  };
}

/**
 * Should the bot answer this message on the owner's own number?
 *
 * The owner's friends, family and regular customers message this number
 * too. The bot answers only:
 *   - someone whose missed call is newer than their last conversation
 *     activity (the reply to our "sorry we missed your call"), within 48 h;
 *   - or someone part-way through the questions, within 48 h.
 * Once a lead is complete it goes quiet until they call again. Once the
 * owner types to them from the phone, it stays out of that chat until
 * they call again.
 */
export function qrShouldReply(conversation, lastMissedCallAt, nowMs = Date.now()) {
  const call = Number(lastMissedCallAt) || 0;
  const updatedAt = Date.parse(conversation?.updatedAt ?? "");
  const takeoverAt = Date.parse(conversation?.ownerTookOverAt ?? "");

  if (Number.isFinite(takeoverAt) && !(call > takeoverAt)) return false;

  const recentCall = call > 0 && nowMs - call <= QR_REPLY_WINDOW_MS;
  if (recentCall && (!conversation || !Number.isFinite(updatedAt) || call > updatedAt)) return true;

  return Boolean(
    conversation && !conversation.completed && Number.isFinite(updatedAt) && nowMs - updatedAt <= QR_REPLY_WINDOW_MS
  );
}

/** Sentences for the settings page, keyed by the gateway's state names. */
export const QR_STATE_MESSAGES = {
  idle: "Not started.",
  starting: "Starting… the QR code appears in a few seconds.",
  qr: "Scan this code with WhatsApp on the business phone: Settings → Linked devices → Link a device.",
  code: "On the business phone open WhatsApp → Linked devices → Link a device → Link with phone number instead, and type this code.",
  connected: "Linked. Finishing setup…",
  reconnecting: "Reconnecting to WhatsApp…",
  expired: "The code ran out before it was used. Press Start again for a new one.",
  offline: "Linked before, but not running right now. Press Reconnect.",
  failed: "Couldn't stay connected to WhatsApp. Press Reconnect, or log out and link again.",
  replaced: "This WhatsApp login was opened somewhere else. Press Reconnect to take it back.",
  logged_out: "WhatsApp unlinked this device. Link it again to keep replying to missed calls.",
  banned: "WhatsApp has blocked this number from being used this way.",
  claimed: "That WhatsApp number is already connected to another MissedCall business.",
  unreachable: "The QR service isn't reachable right now. Try again in a minute.",
};

/** Why a QR connection went to ERROR, said to the owner. */
export const QR_FAILURE_MESSAGES = {
  whatsapp_logged_out: "WhatsApp unlinked MissedCall from your phone (Linked devices). Link it again to keep replying to missed calls.",
  whatsapp_number_blocked: "WhatsApp blocked this number from being used through a linked device. Missed-call replies have stopped. Connect with Facebook (official) instead, or contact us.",
  whatsapp_disconnected: "MissedCall lost its connection to your WhatsApp. Press Reconnect.",
  whatsapp_session_replaced: "Your WhatsApp login was opened somewhere else, so MissedCall was disconnected. Press Reconnect.",
  whatsapp_offline: "MissedCall isn't connected to your WhatsApp right now. Press Reconnect.",
};
