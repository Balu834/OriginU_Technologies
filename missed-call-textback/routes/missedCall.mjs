import crypto from "node:crypto";
import { isValidE164, normalizePhone } from "../lib/phone.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
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
export async function handleMissedCall(ctx, { config, store, wa, businesses }) {
  const token = extractBearerToken(ctx.headers.authorization);

  // The API key identifies which business the automation belongs to, so
  // authentication and tenant resolution are the same step — a key can
  // only ever write into its own business's data.
  const business = businesses ? businesses.byApiKey(token, timingSafeEqualStr) : null;
  const authorised = businesses ? Boolean(business) : token && timingSafeEqualStr(token, config.MISSED_CALL_API_KEY);
  if (!authorised) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  if (business) {
    store = scopedToBusiness(store, business.id);
    config = {
      ...config,
      BUSINESS_NAME: business.name,
      OWNER_NAME: business.ownerName,
      MOHAMED_WHATSAPP_NUMBER: business.ownerWhatsApp,
      WHATSAPP_MISSED_CALL_TEMPLATE: business.missedCallTemplate,
      WHATSAPP_TEMPLATE_LANGUAGE: business.templateLanguage,
    };
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

  const lastAt = await store.lastMissedCallAt(caller);
  if (lastAt && Date.now() - lastAt < DEDUPE_WINDOW_MS) {
    log("missed_call_deduped", { callerNumber: caller });
    return { status: 200, body: { sent: false, deduped: true } };
  }

  log("missed_call_received", { callerNumber: caller });

  const sent = await wa.sendTemplate(caller, config.WHATSAPP_MISSED_CALL_TEMPLATE, config.WHATSAPP_TEMPLATE_LANGUAGE, {
    business_name: config.BUSINESS_NAME,
    owner_name: config.OWNER_NAME,
  });

  if (!sent.ok) {
    // Don't mark as sent — a retry within the dedupe window should still
    // get through instead of being silently swallowed by a failed attempt.
    return { status: 502, body: { sent: false, error: "failed to send WhatsApp template" } };
  }

  await store.markMissedCall(caller, Date.now());

  log("whatsapp_template_sent", { callerNumber: caller, template: config.WHATSAPP_MISSED_CALL_TEMPLATE });
  return { status: 200, body: { sent: true, template: config.WHATSAPP_MISSED_CALL_TEMPLATE } };
}
