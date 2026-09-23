/**
 * POST /razorpay-webhook — the ONLY production path that can put a
 * business on a paid plan.
 *
 * The order of operations here is the security design, so it is worth
 * stating plainly:
 *
 *   1. verify the HMAC over the RAW bytes          <- before parsing
 *   2. only then parse JSON
 *   3. claim event.id exactly once                 <- atomic, before acting
 *   4. resolve the tenant from OUR stored index    <- never from the payload
 *   5. map the status, or refuse to act
 *
 * Step 1 comes before step 2 because parsing attacker-controlled JSON is
 * itself work we should not do for an unauthenticated caller, and because
 * re-serialising a parsed body would change the bytes the HMAC covers.
 *
 * Step 4 is the one that matters for tenancy. The payload carries
 * `notes`, which Razorpay will happily echo back whatever was put there.
 * It is useful in their dashboard and worthless as identity, so it is
 * logged for diagnostics and never read as a business id.
 */
import crypto from "node:crypto";
import {
  verifyWebhookSignature, mapSubscriptionStatus, isHandledEvent,
  HANDLED_EVENTS, isoFromUnix,
} from "../lib/razorpay.mjs";
import { log, logError } from "../lib/logger.mjs";

/** Razorpay retries for up to 24h; a day of margin beyond that is plenty. */
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function handleRazorpayWebhook(ctx, deps) {
  const { store, billing, razorpay } = deps;

  if (!razorpay?.webhookSecret) {
    // Refuse rather than accept unverifiable events. An endpoint that
    // processes webhooks it cannot authenticate is worse than no endpoint.
    logError("razorpay_webhook_not_configured", new Error("no webhook secret"), {});
    return { status: 503, body: { error: "billing webhook is not configured" } };
  }

  const rawBody = ctx.rawBody ?? Buffer.alloc(0);
  const signature = ctx.headers?.["x-razorpay-signature"];

  // 1. Signature first, over the raw bytes, before anything is parsed.
  if (!verifyWebhookSignature(rawBody, signature, razorpay.webhookSecret)) {
    logError("razorpay_webhook_invalid_signature", new Error("signature mismatch"), {
      hasSignature: Boolean(signature),
    });
    return { status: 403, body: { error: "invalid signature" } };
  }

  // 2. Now it is safe to parse.
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    logError("razorpay_webhook_malformed", new Error("invalid JSON"), {});
    return { status: 400, body: { error: "malformed payload" } };
  }

  const event = payload?.event;
  const subscription = payload?.payload?.subscription?.entity ?? null;

  if (!isHandledEvent(event)) {
    // Acknowledged, not acted on. Returning an error would make Razorpay
    // retry an event we will never handle, forever.
    log("razorpay_webhook_ignored_event", { event: String(event ?? "none") });
    return { status: 200, body: { received: true, handled: false } };
  }

  if (!subscription?.id) {
    logError("razorpay_webhook_missing_subscription", new Error("no subscription entity"), { event });
    return { status: 400, body: { error: "missing subscription entity" } };
  }

  // 3. Claim the event exactly once, atomically, BEFORE changing anything.
  // Razorpay retries, and `subscription.charged` carries the period — a
  // replay must not extend the billing period a second time.
  const eventId = payload?.id ? String(payload.id) : deterministicEventId(event, subscription);
  const claimed = await store.claimOnce(`processed:razorpay:${eventId}`, EVENT_TTL_SECONDS);
  if (!claimed) {
    log("razorpay_webhook_duplicate", { event, eventId });
    return { status: 200, body: { received: true, duplicate: true } };
  }

  // 4. Tenant identity from OUR index, never from the payload.
  const businessId = await store.getBusinessByProviderSubscription(subscription.id);
  if (!businessId) {
    // An unknown subscription id changes nothing. There is no default
    // business to fall back to — guessing a tenant here would mean
    // granting or revoking a plan on somebody at random.
    logError("razorpay_webhook_unknown_subscription", new Error("no tenant mapping"), {
      event,
      // Recorded only to show whether the payload TRIED to name a tenant.
      // This value is never used to resolve one.
      notesBusinessIdPresent: Boolean(subscription?.notes?.businessId),
    });
    return { status: 200, body: { received: true, handled: false, reason: "unknown subscription" } };
  }

  // 5. Map the status. An unrecognised one is not a reason to act.
  const status = mapSubscriptionStatus(subscription.status);
  if (!status) {
    logError("razorpay_webhook_unmapped_status", new Error("unknown subscription status"), {
      event, razorpayStatus: String(subscription.status ?? "none"),
    });
    return { status: 200, body: { received: true, handled: false, reason: "unmapped status" } };
  }

  const plan = await planForSubscription(billing, businessId);
  const advancesPeriod = HANDLED_EVENTS[event].advancesPeriod;

  try {
    const existing = await billing.forBusiness(businessId);
    await billing.changePlan({
      businessId,
      plan,
      status,
      provider: "razorpay",
      providerSubscriptionId: subscription.id,
      providerCustomerId: subscription.customer_id ?? null,
      // Only the charge event moves the period. Every other event keeps
      // whatever period we already recorded, so replaying an activation
      // cannot silently re-date a subscription.
      currentPeriodStart: advancesPeriod
        ? isoFromUnix(subscription.current_start)
        : (existing?.currentPeriodStart ?? null),
      currentPeriodEnd: advancesPeriod
        ? isoFromUnix(subscription.current_end)
        : (existing?.currentPeriodEnd ?? null),
      reason: `razorpay:${event}`,
    });
  } catch (err) {
    logError("razorpay_webhook_apply_failed", err, { event, businessId });
    // 500 so Razorpay retries. The event id claim already succeeded, so a
    // retry would be swallowed as a duplicate — release it so the retry
    // can actually do the work.
    await store.releaseClaim?.(`processed:razorpay:${eventId}`);
    return { status: 500, body: { error: "could not apply subscription change" } };
  }

  log("razorpay_webhook_applied", { event, businessId, status, plan, advancesPeriod });
  return { status: 200, body: { received: true, handled: true } };
}

/**
 * Which of OUR plans this subscription represents.
 *
 * Read from the business's existing subscription record, which was
 * written server-side when checkout was initiated. The webhook payload
 * does not get to nominate a plan any more than the browser does.
 */
async function planForSubscription(billing, businessId) {
  const existing = await billing.forBusiness(businessId);
  return existing?.pendingPlan ?? existing?.plan ?? "PRO";
}

/**
 * A stable id for the rare payload with no `id`.
 *
 * Derived from the event and the subscription's own period so that a
 * genuine later charge hashes differently, while a replay of the same
 * charge hashes the same. Without this, an id-less payload would bypass
 * idempotency entirely.
 */
function deterministicEventId(event, subscription) {
  return crypto
    .createHash("sha256")
    .update(`${event}:${subscription.id}:${subscription.current_start ?? ""}:${subscription.current_end ?? ""}:${subscription.status ?? ""}`)
    .digest("hex");
}
