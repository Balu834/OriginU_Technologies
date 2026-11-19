import crypto from "node:crypto";
import { isValidE164, normalizePhone, toE164 } from "../lib/phone.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { clientForBusiness } from "../lib/outbound.mjs";
import { log, maskPhone } from "../lib/logger.mjs";

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
 *
 * The body is meant to be `{"callerNumber":"[call_number]"}`, but it is
 * typed by a business owner on a phone keyboard, which swaps in curly
 * quotes, adds spaces after words and changes capitals. A body that is not
 * JSON is therefore read the way the IVR route reads one (form fields, the
 * query string, smart quotes fixed) rather than refused unread.
 */
export async function handleMissedCall(ctx, deps) {
  const { config, businesses } = deps;
  const token = extractBearerToken(ctx.headers?.authorization);

  // The API key identifies which business the automation belongs to, so
  // authentication and tenant resolution are the same step — a key can
  // only ever write into its own business's data.
  const business = businesses ? businesses.byApiKey(token, timingSafeEqualStr) : null;
  const authorised = businesses ? Boolean(business) : token && timingSafeEqualStr(token, config.MISSED_CALL_API_KEY);
  if (!authorised) {
    // Whether a key was sent at all is what tells a missing header apart
    // from a stale key; the key itself never reaches the log.
    log("missed_call_unauthorized", { route: "/missed-call", hadCredential: Boolean(token) });
    return { status: 401, body: { error: "unauthorized" } };
  }

  // MacroDroid's [call_number] is the number as the phone shows it:
  // "9876543210" or "09876543210", rarely "+91…". Read it the same way the
  // IVR route does, so a phone that never shows a country code still works.
  const input = ctx.json && typeof ctx.json === "object" && !Array.isArray(ctx.json) ? ctx.json : null;
  const fields = input
    ? new Map(Object.entries(input).filter(([, v]) => v !== null && typeof v !== "object").map(([k, v]) => [k, String(v)]))
    : requestFields(ctx);
  const callerNumber = findCallerNumber(fields);
  if (!callerNumber) {
    log("missed_call_bad_number", { route: "/missed-call", ...describeFields(fields, { bodyWasJson: Boolean(input) }) });
    return { status: 400, body: { error: "callerNumber must be a phone number, e.g. +919876543210 or 9876543210" } };
  }

  return reportMissedCall(business, { ...(input ?? {}), callerNumber }, deps);
}

/** Where IVR providers put the caller's number, in the order they are tried. */
const CALLER_FIELDS = [
  "callerNumber", "CallFrom", "From", "caller_id", "callerid", "caller_number",
  "customer_number", "caller", "msisdn", "mobile",
];

/**
 * A field name as compared: no case, spaces, underscores or dashes. A name
 * typed on a phone ("callerNumber " with the keyboard's trailing space,
 * "Caller number", "caller_number") is then the name that was meant.
 */
const fold = (name) => String(name ?? "").toLowerCase().replace(/[\s_-]/g, "");
const CALLER_KEYS = [...new Set(CALLER_FIELDS.map(fold))];

/**
 * Fields that hold a number which is NOT the caller's: the business's own
 * line, the key, and the answer status. Never picked by the fallback below.
 */
const NOT_CALLER_KEYS = new Set(
  ["key", "To", "CallTo", "Called", "called_number", "DialWhomNumber", "did", "virtual_number",
    "DialCallStatus", "dial_call_status", "call_status"].map(fold)
);

/** A value that is a phone number and nothing else: digits, +, spaces, dashes, brackets. */
const PHONE_SHAPED = /^\+?[\d\s().-]{8,20}$/;

/**
 * The E.164 number in a value that is unmistakably a phone number, for the
 * unnamed-field fallback only: written with a leading "+", or an Indian
 * mobile (10 digits from 6-9, optionally after 0, 91 or 0091). Stricter than
 * toE164 on purpose: a Unix timestamp or a date is digits too, and reading
 * one as a number would send a business's message to a stranger.
 */
function unmistakablePhone(value) {
  const v = String(value ?? "").trim();
  if (!PHONE_SHAPED.test(v)) return null;
  if (v.startsWith("+")) return toE164(v);
  const digits = v.replace(/\D/g, "");
  const national = digits.length === 14 && digits.startsWith("0091") ? digits.slice(4)
    : digits.length === 12 && digits.startsWith("91") ? digits.slice(2)
    : digits.length === 11 && digits.startsWith("0") ? digits.slice(1)
    : digits;
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

/**
 * The caller's number from request fields, or null.
 *
 * Named fields first, in CALLER_FIELDS order, compared by folded name. If
 * none is there, the one value that is shaped like a phone number, but only
 * when there is exactly one: two candidates (an IVR's From and To) are a
 * guess, and a guess sends a business's message to the wrong person.
 */
export function findCallerNumber(fields) {
  const byKey = new Map();
  for (const [name, value] of fields ?? []) {
    const v = String(value ?? "").trim();
    if (v && !byKey.has(fold(name))) byKey.set(fold(name), v);
  }
  for (const key of CALLER_KEYS) {
    const e164 = toE164(byKey.get(key));
    if (e164) return e164;
  }
  const candidates = new Set();
  for (const [key, value] of byKey) {
    if (NOT_CALLER_KEYS.has(key)) continue;
    const e164 = unmistakablePhone(value);
    if (e164) candidates.add(e164);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

/** A field's value by folded name, so "Key" and "key " find the key. */
function fieldValue(fields, name) {
  const want = fold(name);
  for (const [k, v] of fields) if (fold(k) === want && String(v ?? "").trim()) return String(v).trim();
  return undefined;
}

/**
 * What arrived, for the log of a request that had no readable caller: field
 * NAMES only (quoted, so a stray space shows), and how many values looked
 * like a phone number. Never a value: one of them is the key.
 */
function describeFields(fields, extra = {}) {
  const names = [...(fields?.keys() ?? [])];
  let phoneShaped = 0;
  for (const [k, v] of fields ?? []) if (!NOT_CALLER_KEYS.has(fold(k)) && unmistakablePhone(v)) phoneShaped += 1;
  // The value of the caller field, if one was named, masked like every
  // number this codebase logs: shows a malformed number without the number.
  const named = CALLER_KEYS.map((key) => [...(fields ?? [])].find(([k, v]) => fold(k) === key && String(v ?? "").trim())?.[1])
    .find(Boolean);
  return {
    callerNumber: maskPhone(String(named ?? "")),
    fieldNames: names.slice(0, 12).map((n) => JSON.stringify(String(n).slice(0, 40))),
    phoneShapedValues: phoneShaped,
    ...extra,
  };
}

/** Curly quotes a phone keyboard substitutes for the straight ones JSON needs. */
function straightenQuotes(text) {
  return text.replace(/[“”„‟″«»]/g, '"').replace(/[‘’‚‛′]/g, "'");
}

/**
 * Fields that say whether a person picked up after the IVR. Only these are
 * read: a provider's overall call status is usually "completed" for every
 * call the IVR itself answered, missed or not, so it can't tell us anything.
 */
const ANSWER_STATUS_FIELDS = ["DialCallStatus", "dial_call_status", "call_status"];
const ANSWERED = new Set(["completed", "answered", "connected", "answer"]);

/**
 * Reads a request's fields from the query string and the body. IVR providers
 * send GET query strings (Exotel Passthru), form posts or JSON, and none of
 * them can be told to use our exact shape, so all three are accepted. A JSON
 * body typed on a phone gets its curly quotes straightened first. An empty
 * value never replaces a filled one of the same name.
 */
function requestFields(ctx) {
  const fields = new Map();
  const put = (k, v) => {
    const value = String(v ?? "");
    if (!value.trim() && String(fields.get(k) ?? "").trim()) return;
    fields.set(k, value);
  };
  for (const [k, v] of ctx.query ?? []) put(k, v);

  const raw = ctx.rawBody?.length ? ctx.rawBody.toString("utf8") : "";
  if (raw) {
    const type = String(ctx.headers?.["content-type"] ?? "");
    const text = straightenQuotes(raw);
    let parsed = null;
    if (type.includes("json") || text.trimStart().startsWith("{")) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) if (v !== null && typeof v !== "object") put(k, String(v));
    } else {
      for (const [k, v] of new URLSearchParams(text)) put(k, v);
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
  const fields = requestFields(ctx);
  const token = extractBearerToken(ctx.headers?.authorization) ?? fieldValue(fields, "key") ?? null;

  const business = businesses ? businesses.byApiKey(token, timingSafeEqualStr) : null;
  const authorised = businesses ? Boolean(business) : token && timingSafeEqualStr(token, config.MISSED_CALL_API_KEY);
  if (!authorised) {
    log("missed_call_unauthorized", { route: "/ivr/missed-call", hadCredential: Boolean(token) });
    return { status: 401, body: { error: "unauthorized" } };
  }

  // A provider that calls on every call, not just missed ones, tells us
  // when someone answered. Those callers were spoken to; no message.
  const answerStatus = ANSWER_STATUS_FIELDS.map((f) => fieldValue(fields, f)).find(Boolean);
  if (answerStatus && ANSWERED.has(answerStatus.trim().toLowerCase())) {
    log("ivr_call_answered_ignored", {});
    return { status: 200, body: { sent: false, reason: "call was answered" } };
  }

  const callerNumber = findCallerNumber(fields);
  if (!callerNumber) {
    log("missed_call_bad_number", { route: "/ivr/missed-call", ...describeFields(fields) });
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
    log("missed_call_bad_number", { callerNumber: maskPhone(String(callerNumber ?? "")) });
    return { status: 400, body: { error: "callerNumber must be a valid E.164 phone number, e.g. +919876543210" } };
  }
  // Optional: a phone automation that only knows the caller's number is
  // enough, and "now" is when the call was missed. A timestamp that IS
  // sent must still be a real one — garbage is a broken client, not a default.
  if (timestamp !== undefined && timestamp !== null && timestamp !== "" && Number.isNaN(Date.parse(timestamp))) {
    log("missed_call_bad_timestamp", {});
    return { status: 400, body: { error: "timestamp must be a valid ISO 8601 date-time" } };
  }

  const caller = normalizePhone(callerNumber);

  // Compared in E.164: an owner number saved before numbers were normalised
  // ("9985324880") must still match the "+919985324880" a call arrives as.
  const ownNumber = toE164(config.MOHAMED_WHATSAPP_NUMBER) ?? normalizePhone(config.MOHAMED_WHATSAPP_NUMBER);
  if (ownNumber && caller === ownNumber) {
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

    // The free month is over: Free is a first-month trial, so no new
    // conversations start until the business moves to a paid plan.
    if (entitlements.freeTrial?.ended) {
      log("missed_call_free_month_ended", {
        businessId: business.id, plan: entitlements.plan, endedAt: entitlements.freeTrial.endsAt,
      });
      return {
        status: 402,
        body: {
          sent: false,
          error: "free first month has ended; upgrade to Pro to keep replying to missed calls",
          reason: "free_month_ended",
          plan: entitlements.plan,
          freeMonthEndedAt: entitlements.freeTrial.endsAt,
        },
      };
    }

    // Leads are what the plan promises ("up to 25 leads"), so they are
    // enforced here too, not only counted. Checked at the start of a
    // conversation, like messages, so nobody is cut off mid-reply.
    // In the free month the 25 is for the whole month since sign-up, which
    // can cross the 1st; on a paid plan it is per calendar month.
    const leadAllowance = entitlements.freeTrial && deps.usage.checkSince
      ? await deps.usage.checkSince(business.id, "leads", entitlements, entitlements.freeTrial.startedAt)
      : await deps.usage.check(business.id, "leads", entitlements);
    if (!leadAllowance.allowed) {
      log("missed_call_over_lead_limit", {
        businessId: business.id, plan: entitlements.plan,
        used: leadAllowance.used, limit: leadAllowance.limit,
      });
      return {
        status: 402,
        body: {
          sent: false,
          error: "lead limit reached for this plan",
          reason: "lead_limit",
          plan: entitlements.plan,
          used: leadAllowance.used,
          limit: leadAllowance.limit,
        },
      };
    }

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
