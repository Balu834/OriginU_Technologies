/**
 * Razorpay: configuration, signature verification, REST client and the
 * subscription state mapping.
 *
 * No SDK. This project has no runtime dependencies and that is
 * deliberate — Razorpay's REST API is HTTP Basic plus JSON, and its
 * webhook signature is an HMAC, both of which `fetch` and `node:crypto`
 * already do. Adding a dependency to a payment path also means adding
 * everything that dependency pulls in to the payment path.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a subscription becomes paid
 * because a signed webhook said so, and for no other reason. Not because
 * checkout opened, not because the create-subscription API returned 200,
 * not because a browser said `plan=PRO`. Those are all things an attacker
 * or an impatient customer can cause; only the webhook is signed with a
 * secret they do not have.
 */
import crypto from "node:crypto";
import { logError } from "./logger.mjs";

const API_BASE = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 10000;

/**
 * Server-only configuration.
 *
 * `keyId` is the only value that may ever reach a browser — Razorpay's
 * checkout widget needs it, and it is public by design. The secret and
 * the webhook secret must never leave the server, which is why
 * `publicConfig()` below is built by naming the one safe field rather
 * than by removing the unsafe ones.
 */
export function razorpayConfig(env = process.env) {
  return {
    keyId: env.RAZORPAY_KEY_ID ?? "",
    keySecret: env.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "",
    // One Razorpay plan id per plan we actually sell. Server-side only:
    // the browser never names a plan id, so it cannot subscribe itself to
    // a cheaper plan than the one it asked for.
    //
    // BUSINESS is deliberately absent. Its price has not been decided, so
    // it is not purchasable, so there is nothing for a plan id to point
    // at — and a variable that exists invites someone to fill it with a
    // plan nobody has priced.
    planIds: {
      PRO: env.RAZORPAY_PLAN_ID_PRO ?? "",
    },
  };
}

/** What may be handed to a template or an API response. Nothing else. */
export function publicConfig(config) {
  return { keyId: config.keyId, configured: isCheckoutConfigured(config) };
}

export function isCheckoutConfigured(config) {
  return Boolean(config?.keyId && config?.keySecret);
}

export function isWebhookConfigured(config) {
  return Boolean(config?.webhookSecret);
}

/** Whether we can actually sell a given plan — i.e. a Razorpay plan id exists for it. */
export function planIdFor(config, plan) {
  return config?.planIds?.[plan] || "";
}

/**
 * Verifies Razorpay's `X-Razorpay-Signature`: HMAC-SHA256 of the RAW
 * body, hex, keyed with the webhook secret.
 *
 * Compared in constant time, and length-checked first because
 * timingSafeEqual throws on a length mismatch. Same shape as the Meta
 * webhook check in lib/whatsapp.mjs, deliberately — one signature
 * routine to get wrong is better than two.
 */
export function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!signatureHeader || !webhookSecret) return false;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") return false;

  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Razorpay subscription status -> our subscription status.
 *
 * Verified against Razorpay's published subscription webhook semantics
 * rather than assumed:
 *
 *   created        no payment yet; the mandate has not been authenticated.
 *                  Not a paid state, so it maps to nothing entitling.
 *   authenticated  the mandate is set up and the first payment was made.
 *                  TRIALING: they are genuinely on the plan but the
 *                  billing cycle has not begun charging.
 *   active         charging normally.
 *   pending        a charge FAILED and Razorpay is retrying. Still
 *                  nominally subscribed, not currently paid up.
 *   halted         retries exhausted. Same entitlement consequence as
 *                  pending — our PAST_DUE already falls back to FREE
 *                  limits — but it is terminal rather than transient.
 *   paused         deliberately suspended; no charges will occur. Not in
 *                  the originally proposed mapping. Treated as PAST_DUE
 *                  because the entitlement consequence is identical:
 *                  stop granting the paid plan, without declaring the
 *                  subscription cancelled.
 *   cancelled      ended by customer or merchant.
 *   completed      all invoices generated; ran to its natural end.
 *                  EXPIRED, not CANCELED — it finished rather than
 *                  being stopped.
 *
 * Anything unrecognised returns null, and an unmapped status must never
 * be guessed at: a status we do not understand is not a reason to grant
 * or revoke a plan.
 */
export const SUBSCRIPTION_STATUS_MAP = Object.freeze({
  authenticated: "TRIALING",
  active: "ACTIVE",
  pending: "PAST_DUE",
  halted: "PAST_DUE",
  paused: "PAST_DUE",
  cancelled: "CANCELED",
  completed: "EXPIRED",
});

export function mapSubscriptionStatus(razorpayStatus) {
  return SUBSCRIPTION_STATUS_MAP[String(razorpayStatus ?? "").toLowerCase()] ?? null;
}

/**
 * Which webhook events we act on.
 *
 * `subscription.updated` is deliberately absent: Razorpay sends it when a
 * subscription changes WITHOUT a state change, so acting on it could only
 * either do nothing or do something wrong. `subscription.created` is
 * absent because nothing has been paid at that point.
 *
 * `advancesPeriod` marks the events that move current_start/current_end.
 * Only `subscription.charged` does, which is exactly the event Razorpay
 * retries — hence the idempotency requirement.
 */
export const HANDLED_EVENTS = Object.freeze({
  "subscription.authenticated": { advancesPeriod: false },
  "subscription.activated": { advancesPeriod: false },
  "subscription.charged": { advancesPeriod: true },
  "subscription.pending": { advancesPeriod: false },
  "subscription.halted": { advancesPeriod: false },
  "subscription.paused": { advancesPeriod: false },
  "subscription.resumed": { advancesPeriod: false },
  "subscription.cancelled": { advancesPeriod: false },
  "subscription.completed": { advancesPeriod: false },
});

export function isHandledEvent(event) {
  return Object.prototype.hasOwnProperty.call(HANDLED_EVENTS, String(event ?? ""));
}

/** Razorpay sends unix seconds; we store ISO everywhere else. */
export function isoFromUnix(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * Minimal REST client. Basic auth with key id and secret, which is what
 * Razorpay's API expects; the secret goes into an Authorization header
 * and nowhere else, and never into a log line or a return value.
 */
export function createRazorpayClient(config, { fetchImpl = fetch } = {}) {
  const auth = "Basic " + Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64");

  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logError("razorpay_unreachable", err, { path });
      return { ok: false, status: 0, body: null };
    }
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Razorpay's error description is API metadata, not a credential.
      logError("razorpay_api_error", new Error(`status ${res.status}`), {
        path,
        status: res.status,
        code: parsed?.error?.code ?? null,
        description: parsed?.error?.description ?? null,
      });
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }

  async function get(path) {
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${path}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logError("razorpay_unreachable", err, { path });
      return { ok: false, status: 0, body: null };
    }
    const parsed = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: parsed };
  }

  return {
    /**
     * Reads a plan back from Razorpay, so the amount we are about to
     * charge can be checked against the amount we displayed.
     */
    fetchPlan(planId) {
      return get(`/plans/${encodeURIComponent(planId)}`);
    },

    /**
     * Creates a subscription against a server-configured plan id.
     *
     * `notes` carries our business id for human diagnostics in the
     * Razorpay dashboard ONLY. Nothing in this codebase reads it back as
     * identity — notes are attacker-influenceable in the general case and
     * tenant identity comes from our own stored index instead.
     */
    createSubscription({ planId, totalCount = 12, notes = {} }) {
      return post("/subscriptions", {
        plan_id: planId,
        total_count: totalCount,
        customer_notify: 1,
        notes,
      });
    },
  };
}
