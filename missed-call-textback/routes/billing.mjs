/**
 * GET /settings/billing — plan, usage and limits for the signed-in
 * business.
 *
 * Read-only on purpose. The plan is not a form field here and never
 * becomes one: starting checkout is a separate route that records an
 * intention, and the only thing that grants a plan is the verified
 * Razorpay webhook. A route that accepted `plan=PRO` would be the whole
 * vulnerability, so it does not exist.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor } from "../lib/users.mjs";
import { publicSubscription, PLAN_ENTITLEMENTS, PLAN_PRICING, purchasablePlans, formatPrice } from "../lib/billing.mjs";
import { billingPage } from "../lib/settingsViews.mjs";
import { isCheckoutConfigured, planIdFor } from "../lib/razorpay.mjs";

export async function handleBillingGet(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { status: 302, headers: { Location: "/leads" }, body: {} };

  // The business is resolved from the stored membership, exactly as
  // everywhere else. Entitlements are looked up for THAT business id, so
  // there is no request-supplied value anywhere in this path.
  const actor = await resolveActor(session, deps.accounts);
  if (!actor?.businessId) {
    return { status: 302, headers: { Location: session.userId ? "/onboarding" : "/leads" }, body: {} };
  }

  const subscription = await deps.billing.forBusiness(actor.businessId);
  const entitlements = await deps.billing.getBusinessEntitlements(actor.businessId);
  const usage = await deps.usage.summary(actor.businessId);

  return {
    status: 200,
    html: billingPage({
      business: deps.businesses?.byId(actor.businessId) ?? null,
      subscription: publicSubscription(subscription),
      entitlements,
      usage,
      plans: PLAN_ENTITLEMENTS,
      role: actor.role,
      // An upgrade action is offered only when the server can genuinely
      // complete one: provider configured AND a price configured.
      // Prices come from the one server-side table; the view renders them
      // and never computes one.
      pricing: Object.fromEntries(
        Object.keys(PLAN_ENTITLEMENTS).map((name) => [name, {
          ...PLAN_PRICING[name],
          display: formatPrice(name),
        }])
      ),
      checkout: {
        available: isCheckoutConfigured(deps.razorpay),
        // A plan is offered only if it is priced AND the provider has a
        // plan id configured for it.
        purchasable: purchasablePlans().filter((name) => Boolean(planIdFor(deps.razorpay, name))),
      },
    }),
  };
}
