/**
 * GET /dashboard — the Overview page.
 *
 * Read-only. It resolves the tenant exactly the way every other
 * authenticated page does (session -> membership -> business), reads that
 * tenant's own leads through the scoped store, and counts them. It adds
 * no new data, no new store method and no new permission: anything this
 * page can show, /leads could already show.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor } from "../lib/users.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { integrationState } from "../lib/integrations.mjs";
import { onboardingStatus } from "../lib/businesses.mjs";
import { overviewPage, RANGES } from "../lib/overviewView.mjs";
import { loginPage } from "../lib/views.mjs";
import { googleSignInAvailable } from "../lib/googleAuth.mjs";

export async function handleOverview(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { status: 200, html: loginPage({ google: googleSignInAvailable(deps.config) }) };

  const actor = await resolveActor(session, deps.accounts);
  if (!actor?.businessId) {
    return { status: 302, headers: { Location: session.userId ? "/onboarding" : "/leads" }, body: {} };
  }

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  if (!business) return { status: 302, headers: { Location: "/leads" }, body: {} };

  const store = scopedToBusiness(deps.store, actor.businessId);
  const leads = await store.listLeads();

  // The integration's persisted status, same source the settings page
  // reads — not re-derived, and never assumed connected.
  const integration = await deps.integrations?.forBusiness(actor.businessId);
  const connection = integrationState(integration);

  const requested = ctx.query?.get("range") ?? "7d";
  const range = Object.hasOwn(RANGES, requested) ? requested : "7d";

  return {
    status: 200,
    html: overviewPage({
      business,
      actor,
      leads,
      range,
      whatsappStatus: connection,
      onboarding: onboardingStatus(business, { connection }),
    }),
  };
}
