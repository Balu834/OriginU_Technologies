/**
 * /settings/phone — the missed-call key and the phone setup guide.
 *
 *   GET  /settings/phone        whether a key exists, and how to set up the phone
 *   POST /settings/phone/key    create (or replace) this business's key
 *
 * A business that signs up had no key at all, and nowhere to get one: only
 * the env-configured `default` business could ever report a missed call.
 * This is the missing half of onboarding.
 *
 * The key is returned once, in the response to the POST that created it,
 * and is never rendered again. The business comes from the membership, so
 * a `businessId` in the form is never read.
 */
import crypto from "node:crypto";
import { currentSession } from "../lib/auth.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { publicBusiness } from "../lib/businesses.mjs";
import { phoneSetupPage } from "../lib/settingsViews.mjs";
import { log, logError } from "../lib/logger.mjs";

const redirect = (to) => ({ status: 302, headers: { Location: to }, body: {} });

/** 32 random bytes; the prefix makes a leaked key recognisable in a log or a paste. */
export function generateMissedCallKey() {
  return "mc_" + crypto.randomBytes(32).toString("base64url");
}

async function actorFor(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return { session: null, actor: null };
  return { session, actor: await resolveActor(session, deps.accounts) };
}

/** The env-configured business's key lives in the environment, not the store. */
function isEnvManaged(business, config) {
  return business?.id === (config?.MIGRATION_DEFAULT_BUSINESS_ID ?? "default");
}

function view(business, deps, actor, extra = {}) {
  return phoneSetupPage({
    business: publicBusiness(business),
    hasKey: Boolean(business?.missedCallApiKey),
    keyCreatedAt: business?.missedCallApiKeyCreatedAt ?? null,
    envManaged: isEnvManaged(business, deps.config),
    canManage: can(actor.role, "manageSettings"),
    role: actor.role,
    baseUrl: deps.config?.WEBHOOK_BASE_URL ?? "",
    actor,
    ...extra,
  });
}

export async function handlePhoneSetupGet(ctx, deps) {
  const { session, actor } = await actorFor(ctx, deps);
  if (!session) return redirect("/leads");
  if (!actor?.businessId) return redirect(session.userId ? "/onboarding" : "/leads");

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  if (!business) return redirect("/leads");

  return { status: 200, html: view(business, deps, actor) };
}

export async function handlePhoneKeyPost(ctx, deps) {
  const { session, actor } = await actorFor(ctx, deps);
  if (!session) return { status: 401, body: { error: "not signed in" } };
  if (!actor?.businessId) return { status: 403, body: { error: "no business for this account" } };

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  if (!business) return { status: 404, body: { error: "business not found" } };

  if (!can(actor.role, "manageSettings")) {
    log("phone_key_denied", { role: actor.role });
    return { status: 403, html: view(business, deps, actor, { error: "Your role cannot create a key." }) };
  }

  // The default tenant's key is authoritative in the environment and is
  // re-applied on every load, so a stored key would be silently ignored.
  // Refuse rather than hand out a key that can never work.
  if (isEnvManaged(business, deps.config)) {
    return { status: 409, html: view(business, deps, actor, { error: "This business's key is managed by the MissedCall team." }) };
  }

  const key = generateMissedCallKey();
  const now = new Date().toISOString();
  const updated = { ...business, missedCallApiKey: key, missedCallApiKeyCreatedAt: now, updatedAt: now };

  try {
    await deps.store.saveBusiness(updated);
  } catch (err) {
    logError("phone_key_save_failed", err, { businessId: actor.businessId });
    return { status: 500, html: view(business, deps, actor, { error: "Could not create a key just now. Try again." }) };
  }

  // The key itself is never logged.
  log("phone_key_created", { businessId: actor.businessId, replaced: Boolean(business.missedCallApiKey) });

  return {
    status: 200,
    headers: { "Cache-Control": "no-store" },
    html: view(updated, deps, actor, { newKey: key }),
  };
}
