import crypto from "node:crypto";
import { isValidE164, normalizePhone } from "../lib/phone.mjs";
import { log } from "../lib/logger.mjs";

const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // resending the template within 10 min of a missed call is treated as a duplicate/retry

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractBearerToken(authHeader) {
  if (typeof authHeader !== "string") return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * POST /missed-call — called by the phone automation (MacroDroid/Tasker).
 * Auth: `Authorization: Bearer <MISSED_CALL_API_KEY>`.
 */
export async function handleMissedCall(ctx, { config, store, wa }) {
  const token = extractBearerToken(ctx.headers.authorization);
  if (!token || !timingSafeEqualStr(token, config.MISSED_CALL_API_KEY)) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const { callerNumber, timestamp } = ctx.json ?? {};

  if (!callerNumber || !isValidE164(callerNumber)) {
    return { status: 400, body: { error: "callerNumber must be a valid E.164 phone number, e.g. +919876543210" } };
  }
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    return { status: 400, body: { error: "timestamp must be a valid ISO 8601 date-time" } };
  }

  const caller = normalizePhone(callerNumber);

  if (config.MOHAMED_WHATSAPP_NUMBER && caller === normalizePhone(config.MOHAMED_WHATSAPP_NUMBER)) {
    log("missed_call_ignored_own_number", {});
    return { status: 200, body: { sent: false, reason: "ignored own number" } };
  }

  const lastAt = store.lastMissedCallAt(caller);
  if (lastAt && Date.now() - lastAt < DEDUPE_WINDOW_MS) {
    log("missed_call_deduped", { callerNumber: caller });
    return { status: 200, body: { sent: false, deduped: true } };
  }

  log("missed_call_received", { callerNumber: caller });

  const sent = await wa.sendTemplate(caller, config.WHATSAPP_MISSED_CALL_TEMPLATE, config.WHATSAPP_TEMPLATE_LANGUAGE, [
    config.BUSINESS_NAME,
    config.OWNER_NAME,
  ]);

  store.markMissedCall(caller, Date.now());

  if (!sent.ok) {
    return { status: 502, body: { sent: false, error: "failed to send WhatsApp template" } };
  }

  log("whatsapp_template_sent", { callerNumber: caller, template: config.WHATSAPP_MISSED_CALL_TEMPLATE });
  return { status: 200, body: { sent: true, template: config.WHATSAPP_MISSED_CALL_TEMPLATE } };
}
