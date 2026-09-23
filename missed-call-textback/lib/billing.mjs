/**
 * Subscriptions and entitlements.
 *
 * `changePlan` has exactly two production callers: the verified Razorpay
 * webhook (routes/razorpayWebhook.mjs) and the console script. No HTTP
 * route reachable by a browser calls it, and no route accepts a plan
 * parameter, so a customer cannot put themselves on a paid plan by
 * asking. Opening checkout does not do it either — that only records an
 * INTENT, and intent is not payment.
 *
 * The plan lives on the business, never on the session or the request.
 * A browser that sends plan=PRO is not refused, it is simply never read.
 *
 * ON THE LIMIT VALUES BELOW: the product has never defined a quota. No
 * pricing page, no product requirement, no prior code specifies one — the
 * audit for this task found zero billing constructs of any kind. So the
 * numbers here are PROVISIONAL: chosen to stop abuse, not to express a
 * commercial decision, and sized so the one business currently in
 * production (1 lead, 3 messages to date) is nowhere near them. They are
 * collected in this one table so replacing them with real pricing is a
 * single edit.
 */

export const PLANS = ["FREE", "PRO", "BUSINESS"];

export const SUBSCRIPTION_STATUSES = [
  "TRIALING", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED",
];

/** Statuses that entitle a business to what its plan says. Anything else falls back to FREE. */
const HONOURED_STATUSES = new Set(["TRIALING", "ACTIVE"]);

export function isValidPlan(plan) {
  return PLANS.includes(plan);
}

export function isValidStatus(status) {
  return SUBSCRIPTION_STATUSES.includes(status);
}

/**
 * PROVISIONAL limits — see the module note. `null` means no limit.
 *
 * The two metrics are the two things this product actually does: it
 * starts conversations that become leads, and it sends WhatsApp messages
 * that Meta bills for. There is deliberately no "AI requests" metric,
 * because there is no LLM in this system — lead extraction is rule-based
 * (lib/extract.mjs). Inventing that meter would mean billing for work
 * that never happens.
 */
export const PLAN_ENTITLEMENTS = Object.freeze({
  FREE: Object.freeze({
    leadsPerMonth: 25,
    messagesPerMonth: 250,
    teamMembers: 1,
    transcripts: true,
    prioritySupport: false,
  }),
  PRO: Object.freeze({
    leadsPerMonth: 500,
    messagesPerMonth: 5000,
    teamMembers: 5,
    transcripts: true,
    prioritySupport: true,
  }),
  BUSINESS: Object.freeze({
    leadsPerMonth: null,
    messagesPerMonth: null,
    teamMembers: null,
    transcripts: true,
    prioritySupport: true,
  }),
});

/** Which entitlement key a usage metric is limited by. */
export const METRIC_LIMITS = Object.freeze({
  leads: "leadsPerMonth",
  messages: "messagesPerMonth",
});

/**
 * The subscription every business has before anyone has paid for
 * anything. It is a real record shape rather than a null: code that asks
 * "what is this business entitled to" should never have to special-case
 * the absence of a subscription.
 */
export function defaultSubscription(businessId, now = new Date().toISOString()) {
  return {
    id: `sub-default-${businessId}`,
    businessId,
    plan: "FREE",
    status: "ACTIVE",
    provider: "none",
    providerCustomerId: null,
    providerSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    pendingPlan: null,
    createdAt: now,
    updatedAt: now,
    // Marks a record that was assumed rather than stored, so the dashboard
    // can be honest that nobody has chosen a plan yet.
    implicit: true,
  };
}

export function subscriptionRecord({
  id,
  businessId,
  plan = "FREE",
  status = "ACTIVE",
  provider = "none",
  providerCustomerId = null,
  providerSubscriptionId = null,
  currentPeriodStart = null,
  currentPeriodEnd = null,
  pendingPlan = null,
  createdAt = null,
  updatedAt = null,
} = {}) {
  if (!businessId) throw new Error("a subscription must belong to a business");
  if (!isValidPlan(plan)) throw new Error(`unknown plan: ${plan}`);
  if (!isValidStatus(status)) throw new Error(`unknown subscription status: ${status}`);

  const now = new Date().toISOString();
  return {
    id: id ?? `sub-${businessId}`,
    businessId,
    plan,
    status,
    provider,
    providerCustomerId,
    providerSubscriptionId,
    currentPeriodStart,
    currentPeriodEnd,
    // The plan checkout was started for. Recorded server-side BEFORE the
    // customer pays, so the webhook can learn which plan a payment is for
    // without the payload telling it.
    pendingPlan,
    createdAt: createdAt ?? now,
    updatedAt: updatedAt ?? now,
    implicit: false,
  };
}

/**
 * The plan a subscription actually entitles you to right now.
 *
 * A PRO subscription that is PAST_DUE or CANCELED does not keep granting
 * PRO limits — otherwise cancelling would be free and the entitlement
 * system would be decorative.
 */
export function effectivePlan(subscription) {
  if (!subscription || !isValidPlan(subscription.plan)) return "FREE";
  return HONOURED_STATUSES.has(subscription.status) ? subscription.plan : "FREE";
}

/** Safe to send to a browser. No provider ids — those identify a payment account. */
export function publicSubscription(subscription) {
  if (!subscription) return null;
  return {
    plan: subscription.plan,
    status: subscription.status,
    effectivePlan: effectivePlan(subscription),
    provider: subscription.provider,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    pendingPlan: subscription.pendingPlan ?? null,
    implicit: Boolean(subscription.implicit),
  };
}

export function createBillingService(store) {
  return {
    /** The stored subscription, or the implicit FREE one every business starts with. */
    async forBusiness(businessId) {
      if (!businessId) return null;
      const stored = await store.getSubscription?.(businessId);
      return stored ?? defaultSubscription(businessId);
    },

    /**
     * THE entitlement resolver. Everything that needs to know what a
     * business may do asks this, and it takes a businessId that the
     * caller resolved from the session — never a plan from a request.
     */
    async getBusinessEntitlements(businessId) {
      const subscription = await this.forBusiness(businessId);
      const plan = effectivePlan(subscription);
      return {
        businessId,
        plan,
        nominalPlan: subscription?.plan ?? "FREE",
        status: subscription?.status ?? "ACTIVE",
        limits: PLAN_ENTITLEMENTS[plan],
      };
    },

    /**
     * Moves a business to a plan. Server-side only, by construction:
     * nothing in routes/ calls this, and no route accepts a plan
     * parameter, so the only ways in are the console script and tests.
     *
     * `reason` is recorded because a plan change with no traceable cause
     * is indistinguishable from a bug or an abuse.
     */
    async changePlan({ businessId, plan, status = "ACTIVE", provider = "none", reason = "manual", ...rest }) {
      if (!businessId) throw new Error("changePlan requires a businessId");
      if (!isValidPlan(plan)) throw new Error(`unknown plan: ${plan}`);
      if (!isValidStatus(status)) throw new Error(`unknown subscription status: ${status}`);

      const existing = await store.getSubscription?.(businessId);
      const record = subscriptionRecord({
        ...(existing && !existing.implicit ? existing : {}),
        businessId,
        plan,
        status,
        provider,
        providerCustomerId: rest.providerCustomerId ?? existing?.providerCustomerId ?? null,
        providerSubscriptionId: rest.providerSubscriptionId ?? existing?.providerSubscriptionId ?? null,
        currentPeriodStart: rest.currentPeriodStart ?? null,
        currentPeriodEnd: rest.currentPeriodEnd ?? null,
        pendingPlan: rest.pendingPlan ?? existing?.pendingPlan ?? null,
        createdAt: existing?.createdAt ?? null,
        updatedAt: new Date().toISOString(),
      });
      record.changeReason = String(reason);

      await store.saveSubscription(record);
      return record;
    },

    /**
     * Records that checkout was STARTED for a plan. Grants nothing.
     *
     * This is the step that lets the webhook know which plan a later
     * payment is for without trusting the payload to tell it. The
     * business stays on whatever plan it already had — `pendingPlan` is
     * an intention, and the entitlement resolver does not read it.
     *
     * It also writes the provider -> tenant index, which is the
     * authoritative mapping the webhook resolves against.
     */
    async beginCheckout({ businessId, plan, providerSubscriptionId }) {
      if (!businessId) throw new Error("beginCheckout requires a businessId");
      if (!isValidPlan(plan) || plan === "FREE") throw new Error(`not a purchasable plan: ${plan}`);
      if (!providerSubscriptionId) throw new Error("beginCheckout requires a provider subscription id");

      const existing = await store.getSubscription?.(businessId);
      const record = subscriptionRecord({
        ...(existing && !existing.implicit ? existing : {}),
        businessId,
        // Unchanged: paying for PRO is what makes someone PRO.
        plan: existing && !existing.implicit ? existing.plan : "FREE",
        status: existing && !existing.implicit ? existing.status : "ACTIVE",
        provider: "razorpay",
        providerSubscriptionId,
        providerCustomerId: existing?.providerCustomerId ?? null,
        currentPeriodStart: existing?.currentPeriodStart ?? null,
        currentPeriodEnd: existing?.currentPeriodEnd ?? null,
        pendingPlan: plan,
        createdAt: existing?.createdAt ?? null,
        updatedAt: new Date().toISOString(),
      });
      record.changeReason = "checkout started";

      await store.saveSubscription(record);
      await store.saveProviderSubscription(providerSubscriptionId, businessId);
      return record;
    },
  };
}
