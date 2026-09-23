/**
 * /settings/business — editing the business profile after onboarding.
 *
 * This existed nowhere until now: `saveBusiness` was called only during
 * onboarding, so a business's name, services, areas, greeting, timezone
 * and — most importantly — the WhatsApp number that every lead alert is
 * sent to were write-once. A customer who mistyped their number at signup
 * had no way to fix it, and every lead notification went to the wrong
 * place permanently.
 *
 * Authorization is the same shape as every other settings route: session
 * -> membership -> role. The business being edited comes from the stored
 * membership, so a `businessId` in the form is not validated, it is
 * simply never read.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { applyBusinessProfile, publicBusiness } from "../lib/businesses.mjs";
import { isValidE164, normalizePhone } from "../lib/phone.mjs";
import { businessSettingsPage } from "../lib/settingsViews.mjs";
import { log, logError } from "../lib/logger.mjs";

const redirect = (to) => ({ status: 302, headers: { Location: to }, body: {} });

async function actorFor(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { session: null, actor: null };
  return { session, actor: await resolveActor(session, deps.accounts) };
}

export async function handleBusinessSettingsGet(ctx, deps) {
  const { session, actor } = await actorFor(ctx, deps);
  if (!session) return redirect("/leads");
  if (!actor?.businessId) return redirect(session.userId ? "/onboarding" : "/leads");

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  if (!business) return redirect("/leads");

  return {
    status: 200,
    html: businessSettingsPage({
      // publicBusiness, not the raw record — the stored business also
      // carries the dashboard password hash and the missed-call API key.
      business: publicBusiness(business),
      canManage: can(actor.role, "manageSettings"),
      role: actor.role,
      saved: ctx.query?.get("saved") === "1",
      actor,
    }),
  };
}

export async function handleBusinessSettingsPost(ctx, deps) {
  const { session, actor } = await actorFor(ctx, deps);
  if (!session) return { status: 401, body: { error: "not signed in" } };
  if (!actor?.businessId) return { status: 403, body: { error: "no business for this account" } };

  if (!can(actor.role, "manageSettings")) {
    log("business_settings_denied", { role: actor.role });
    return {
      status: 403,
      html: businessSettingsPage({
        business: publicBusiness(deps.businesses?.byId(actor.businessId)),
        canManage: false,
        role: actor.role,
        error: "Your role cannot change business settings.",
      }),
    };
  }

  // Load the CURRENT record, from the id the membership gave us.
  const existing = deps.businesses?.byId(actor.businessId) ?? null;
  if (!existing) return { status: 404, body: { error: "business not found" } };

  const form = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
  const input = Object.fromEntries(
    ["name", "ownerName", "ownerWhatsApp", "industry", "businessPhone", "timezone", "greeting", "services", "areas"]
      .map((k) => [k, form.get(k) ?? ""])
  );

  const { business, errors } = applyBusinessProfile(existing, input, {
    isValidPhone: isValidE164,
    normalizePhone,
  });

  if (Object.keys(errors).length) {
    return {
      status: 400,
      html: businessSettingsPage({
        business: { ...publicBusiness(existing), ...publicBusiness(business) },
        canManage: true,
        role: actor.role,
        errors,
      }),
    };
  }

  try {
    await deps.store.saveBusiness(business);
  } catch (err) {
    logError("business_settings_save_failed", err, { businessId: actor.businessId });
    return { status: 500, body: { error: "could not save those settings" } };
  }

  // Saving the number is not verifying it. Nothing is sent here — a
  // WhatsApp message on every settings save would spend the business's
  // money to confirm a form submission.
  log("business_settings_updated", { businessId: actor.businessId });

  return redirect("/settings/business?saved=1");
}
