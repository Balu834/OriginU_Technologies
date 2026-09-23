/**
 * GET /settings/billing — plan, usage and limits for the signed-in
 * business.
 *
 * Read-only on purpose. There is no POST, because there is nothing a
 * browser is allowed to change here: the plan is not a form field, and
 * until a payment provider is connected there is no trustworthy event
 * that could move a business onto a paid plan. A route that accepted
 * `plan=PRO` would be the whole vulnerability, so it does not exist.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor } from "../lib/users.mjs";
import { publicSubscription, PLAN_ENTITLEMENTS } from "../lib/billing.mjs";
import { billingPage } from "../lib/settingsViews.mjs";

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
    }),
  };
}
