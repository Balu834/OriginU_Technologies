/**
 * GET /billing/status — the authoritative answer to "what plan am I on?"
 *
 * This exists so the browser never has to decide. After checkout the
 * page asks here, and keeps asking, until the server says the plan
 * changed — which only happens when the verified Razorpay webhook says
 * so. The checkout widget's own success callback is not consulted,
 * because it proves the customer completed a form, not that money moved.
 *
 * Built by naming safe fields. No provider ids, no credentials, nothing
 * about any other tenant.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor } from "../lib/users.mjs";
import { publicSubscription, PLAN_ENTITLEMENTS, formatPrice } from "../lib/billing.mjs";

export async function handleBillingStatus(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { status: 401, body: { error: "not signed in" } };

  // Business from the stored membership, as everywhere else.
  const actor = await resolveActor(session, deps.accounts);
  if (!actor?.businessId) return { status: 403, body: { error: "no business for this account" } };

  const subscription = await deps.billing.forBusiness(actor.businessId);
  const entitlements = await deps.billing.getBusinessEntitlements(actor.businessId);
  const usage = await deps.usage.summary(actor.businessId);
  const view = publicSubscription(subscription);

  return {
    status: 200,
    body: {
      // `plan` is the EFFECTIVE plan — what this business may actually do
      // right now. A PRO subscription that is PAST_DUE reports FREE here,
      // because that is what its limits are.
      plan: entitlements.plan,
      nominalPlan: view.plan,
      status: view.status,
      // True between starting checkout and the webhook confirming it.
      pending: Boolean(view.pendingPlan && view.pendingPlan !== view.plan),
      pendingPlan: view.pendingPlan,
      currentPeriodStart: view.currentPeriodStart,
      currentPeriodEnd: view.currentPeriodEnd,
      limits: entitlements.limits,
      usage: usage.counts,
      usagePeriodStart: usage.periodStart,
      usagePeriodEnd: usage.periodEnd,
      displayPrice: formatPrice(entitlements.plan),
      plans: Object.fromEntries(
        Object.keys(PLAN_ENTITLEMENTS).map((name) => [name, { displayPrice: formatPrice(name) }])
      ),
    },
  };
}
