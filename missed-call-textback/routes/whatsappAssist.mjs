/**
 * POST /settings/whatsapp/assist — "No Facebook? We'll set it up for you."
 *
 * Meta only lets a number join the WhatsApp Business Platform through a
 * Facebook login, so an owner without one (or who'd rather not) asks us to
 * do that part. They give the WhatsApp number, how they want help (WhatsApp
 * chat or in person, never a phone call) and a good time; we
 * do the Facebook side, and they only share the code Meta texts them.
 *
 * The request is saved on the business so the page shows it was received,
 * support is emailed when email is configured, and if a support WhatsApp
 * number is configured the owner is taken straight to a WhatsApp chat with
 * the details already typed, so the request reaches a person even when
 * email isn't set up.
 */
import { currentSession } from "../lib/auth.mjs";
import { resolveActor, can } from "../lib/users.mjs";
import { toE164 } from "../lib/phone.mjs";
import { createMailer } from "../lib/mailer.mjs";
import { log, logError } from "../lib/logger.mjs";
import { ASSIST_TIMES as BEST_TIMES, ASSIST_METHODS } from "../lib/settingsViews.mjs";

const redirect = (to) => ({ status: 302, headers: { Location: to }, body: {} });
const formOf = (ctx) => new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");

/** Digits only, for a wa.me link. Empty when the configured value isn't a usable number. */
export function supportWhatsAppDigits(config) {
  const e164 = toE164(String(config?.SUPPORT_WHATSAPP_NUMBER ?? ""));
  return e164 ? e164.replace(/\D/g, "") : "";
}

export function assistMessage({ businessName, ownerName, number, bestTime, method = "whatsapp" }) {
  return [
    "Hi, please set up MissedCall WhatsApp for my business.",
    `Business: ${businessName || "-"}`,
    ownerName ? `Owner: ${ownerName}` : "",
    `WhatsApp number to connect: ${number}`,
    `Help by: ${ASSIST_METHODS[method] ?? ASSIST_METHODS.whatsapp}`,
    `Best time to reach me: ${BEST_TIMES[bestTime] ?? BEST_TIMES.anytime}`,
  ].filter(Boolean).join("\n");
}

export async function handleWhatsappAssistPost(ctx, deps) {
  const session = await currentSession(ctx, deps.store);
  if (!session) return redirect("/leads");
  const actor = await resolveActor(session, deps.accounts);
  if (!actor?.businessId) return redirect(session.userId ? "/onboarding" : "/leads");
  if (!can(actor.role, "manageSettings")) return redirect("/settings/whatsapp");

  const business = deps.businesses?.byId(actor.businessId) ?? null;
  if (!business) return redirect("/leads");

  const form = formOf(ctx);
  // A typed number has to be usable; only a blank one falls back to the
  // business phone, so a typo is pointed out rather than quietly replaced.
  const typed = String(form.get("number") ?? "").trim();
  const number = typed ? toE164(typed) : toE164(business.businessPhone ?? "");
  if (!number) return redirect("/settings/whatsapp?a=bad");
  const bestTime = BEST_TIMES[form.get("bestTime")] ? form.get("bestTime") : "anytime";

  const method = ASSIST_METHODS[form.get("method")] ? form.get("method") : "whatsapp";

  const setupRequest = { number, bestTime, method, requestedAt: new Date().toISOString() };
  try {
    await deps.store.saveBusiness({ ...business, setupRequest, updatedAt: setupRequest.requestedAt });
  } catch (err) {
    logError("whatsapp_assist_save_failed", err, { businessId: actor.businessId });
    return redirect("/settings/whatsapp?a=fail");
  }
  log("whatsapp_setup_requested", { businessId: actor.businessId, bestTime, method });

  const text = assistMessage({ businessName: business.name, ownerName: business.ownerName, number, bestTime, method });

  // Best effort: a missing or failing mailer must not lose the request,
  // which is already saved and also goes out over WhatsApp below.
  const mailer = deps.mailer ?? createMailer(deps.config ?? {});
  if (mailer.configured) {
    await mailer.send({
      to: deps.config?.SUPPORT_EMAIL || "support@originutech.in",
      subject: `WhatsApp setup request: ${business.name || "a business"}`,
      text,
    });
  }

  const support = supportWhatsAppDigits(deps.config);
  if (support) return redirect(`https://wa.me/${support}?text=${encodeURIComponent(text)}`);
  return redirect("/settings/whatsapp?a=sent");
}
