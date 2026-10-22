import crypto from "node:crypto";
import { isValidE164, normalizePhone, toE164 } from "../lib/phone.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { clientForBusiness } from "../lib/outbound.mjs";
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
export async function handleMissedCall(ctx, deps) {
  const { config, businesses } = deps;
  const token = extractBearerToken(ctx.headers.authorization);

  // The API key identifies which business the automation belongs to, so
  // authentication and tenant resolution are the same step — a key can
  // only ever write into its own business's data.
  const business = businesses ? businesses.byApiKey(token, timingSafeEqualStr) : null;
  const authorised = businesses ? Boolean(business) : token && timingSafeEqualStr(token, config.MISSED_CALL_API_KEY);
  if (!authorised) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  return reportMissedCall(business, ctx.json ?? {}, deps);
}

/** Where IVR providers put the caller's number, in the order they are tried. */
const CALLER_FIELDS = [
  "callerNumber", "CallFrom", "From", "caller_id", "callerid", "caller_number",
  "customer_number", "caller", "msisdn", "mobile",
];

/**
 * Fields that say whether a person picked up after the IVR. Only these are
 * read: a provider's overall call status is usually "completed" for every
 * call the IVR itself answered, missed or not, so it can't tell us anything.
 */
const ANSWER_STATUS_FIELDS = ["DialCallStatus", "dial_call_status", "call_status"];
const ANSWERED = new Set(["completed", "answered", "connected", "answer"]);

/**
 * Reads an IVR request's fields from the query string and the body. Providers
 * send GET query strings (Exotel Passthru), form posts or JSON, and none of
 * them can be told to use our exact shape, so all three are accepted.
 */
function ivrFields(ctx) {
  const fields = new Map();
  for (const [k, v] of ctx.query ?? []) fields.set(k, v);

  const raw = ctx.rawBody?.length ? ctx.rawBody.toString("utf8") : "";
  if (raw) {
    const type = String(ctx.headers?.["content-type"] ?? "");
    let parsed = null;
    if (type.includes("json") || raw.trimStart().startsWith("{")) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) if (v !== null && typeof v !== "object") fields.set(k, String(v));
    } else {
      for (const [k, v] of new URLSearchParams(raw)) fields.set(k, v);
    }
  }
  return fields;
}

/**
 * GET or POST /ivr/missed-call — for cloud telephony / IVR providers
 * (Exotel, Knowlarity, MyOperator, Twilio…), whose calls never ring a phone,
 * so the MacroDroid automation has nothing to trigger on.
 *
 * Auth: the same missed-call key, as `Authorization: Bearer <key>` or, since
 * most IVR consoles can only be given a URL, as `?key=<key>`. The rest is
 * reportMissedCall, unchanged: same dedupe, allowance and template.
 */
export async function handleIvrMissedCall(ctx, deps) {
  const { config, businesses } = deps;
  const fields = ivrFields(ctx);
  const token = extractBearerToken(ctx.headers?.authorization) ?? fields.get("key") ?? null;

  const business = businesses ? businesses.byApiKey(token, timingSafeEqualStr) : null;
  const authorised = businesses ? Boolean(business) : token && timingSafeEqualStr(token, config.MISSED_CALL_API_KEY);
  if (!authorised) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  // A provider that calls on every call, not just missed ones, tells us
  // when someone answered. Those callers were spoken to; no message.
  const answerStatus = ANSWER_STATUS_FIELDS.map((f) => fields.get(f)).find(Boolean);
  if (answerStatus && ANSWERED.has(answerStatus.trim().toLowerCase())) {
    log("ivr_call_answered_ignored", {});
    return { status: 200, body: { sent: false, reason: "call was answered" } };
  }

  const rawCaller = CALLER_FIELDS.map((f) => fields.get(f)).find(Boolean);
  const callerNumber = toE164(rawCaller);
  if (!callerNumber) {
    return {
      status: 400,
      body: { error: `no caller number found; send it as one of: ${CALLER_FIELDS.join(", ")}` },
    };
  }

  return reportMissedCall(business, { callerNumber }, deps);
}

/**
 * One missed call for one business: validate, dedupe, check the plan's
 * allowance, send the template, record it.
 *
 * Split from the handler so the signed-in "Send a test message" button
 * goes through exactly this path — same dedupe window, same allowance,
 * same usage count — rather than a second way of sending that could drift.
 * The caller has already established which business this is; nothing in
 * `input` can change it.
 */
export async function reportMissedCall(business, input, deps) {
  let { config, store } = deps;
  const { wa } = deps;

  if (business) {
    store = scopedToBusiness(store, business.id);
    config = {
      ...config,
      BUSINESS_NAME: business.name,
      OWNER_NAME: business.ownerName,
      MOHAMED_WHATSAPP_NUMBER: business.ownerWhatsApp,
      // A business created through signup has no template of its own
      // recorded; a blank here would send a template with no name. The
      // deployment default is the one Embedded Signup creates for it.
      WHATSAPP_MISSED_CALL_TEMPLATE: business.missedCallTemplate || config.WHATSAPP_MISSED_CALL_TEMPLATE,
      WHATSAPP_TEMPLATE_LANGUAGE: business.templateLanguage || config.WHATSAPP_TEMPLATE_LANGUAGE,
    };
  }

  const { callerNumber, timestamp } = input ?? {};

  if (!callerNumber || !isValidE164(callerNumber)) {
    return { status: 400, body: { error: "callerNumber must be a valid E.164 phone number, e.g. +919876543210" } };
  }
  // Optional: a phone automation that only knows the caller's number is
  // enough, and "now" is when the call was missed. A timestamp that IS
  // sent must still be a real one — garbage is a broken client, not a default.
  if (timestamp !== undefined && timestamp !== null && timestamp !== "" && Number.isNaN(Date.parse(timestamp))) {
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

  // Entitlement check BEFORE the billable send. The business comes from
  // the API key that authenticated this request, so a caller cannot ask
  // for someone else's allowance, and no plan value is read from the
  // request at all.
  //
  // This is the gate for the whole product: a missed call is what starts
  // a conversation that becomes a lead. Enforcing here, rather than
  // mid-conversation, means a business that hits its limit stops starting
  // NEW conversations instead of going silent on a customer who is
  // already mid-reply.
  if (business && deps.billing && deps.usage) {
    const entitlements = await deps.billing.getBusinessEntitlements(business.id);
    const allowance = await deps.usage.check(business.id, "messages", entitlements);
    if (!allowance.allowed) {
      // Nothing is sent and nothing is recorded — no half-finished state
      // that looks to the owner like the customer was contacted.
      log("missed_call_over_limit", {
        businessId: business.id, plan: entitlements.plan,
        used: allowance.used, limit: allowance.limit,
      });
      return {
        status: 402,
        body: {
          sent: false,
          error: "monthly message limit reached for this plan",
          plan: entitlements.plan,
          used: allowance.used,
          limit: allowance.limit,
        },
      };
    }
  }

  // The template goes out on this business's own integration. Without one
  // there is nothing legitimate to send with: falling back to the shared
  // client would text this business's customer from a different
  // business's WhatsApp number.
  const client = business ? await clientForBusiness(business.id, deps) : wa;
  if (!client) {
    log("missed_call_no_integration", { businessId: business?.id });
    return { status: 503, body: { sent: false, error: "this business has no WhatsApp integration configured" } };
  }

  const sent = await client.sendTemplate(caller, config.WHATSAPP_MISSED_CALL_TEMPLATE, config.WHATSAPP_TEMPLATE_LANGUAGE, {
    business_name: config.BUSINESS_NAME,
    owner_name: config.OWNER_NAME,
  });

  if (!sent.ok) {
    // Meta's error envelope (code + message) carries no credentials, and
    // without it a failed send is undiagnosable from the logs.
    log("whatsapp_template_failed", {
      callerNumber: caller,
      template: config.WHATSAPP_MISSED_CALL_TEMPLATE,
      status: sent.status ?? null,
      metaError: sent.body?.error
        ? { code: sent.body.error.code ?? null, subcode: sent.body.error.error_subcode ?? null, message: sent.body.error.message ?? null }
        : null,
    });
    // Don't mark as sent — a retry within the dedupe window should still
    // get through instead of being silently swallowed by a failed attempt.
    // Only a caller holding this business's API key reaches this line, and
    // Meta's code/message is the one thing that says what to fix.
    return {
      status: 502,
      body: {
        sent: false,
        error: "failed to send WhatsApp template",
        metaError: sent.body?.error
          ? { code: sent.body.error.code ?? null, subcode: sent.body.error.error_subcode ?? null, message: sent.body.error.message ?? null }
          : null,
      },
    };
  }

  await store.markMissedCall(caller, Date.now());

  // Counted only now, after Meta accepted it. A failed send returned
  // above without reaching this line — the business got nothing, so it is
  // not usage.
  if (business && deps.usage) {
    await deps.usage.record(business.id, "messages", 1);
  }

  log("whatsapp_template_sent", { callerNumber: caller, template: config.WHATSAPP_MISSED_CALL_TEMPLATE });
  return { status: 200, body: { sent: true, template: config.WHATSAPP_MISSED_CALL_TEMPLATE } };
}
