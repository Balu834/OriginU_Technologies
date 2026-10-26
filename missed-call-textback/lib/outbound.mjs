/**
 * Resolving which WhatsApp credentials a business may send with.
 *
 * There is exactly one rule here and it is worth stating plainly: a
 * business sends on its own integration or it does not send at all. It
 * never borrows the deployment's global client, because "borrowing"
 * means a customer of business B receives a WhatsApp from business A's
 * number — a cross-tenant leak that looks, to everyone involved, like a
 * working feature.
 *
 * This exists as its own module because the same resolution is needed in
 * three places (inbound replies, missed-call templates, owner-notification
 * retries) and it had drifted: two of them reached for the shared client
 * and silently sent on the default tenant's number.
 */
import { createWhatsAppClientFor } from "./whatsapp.mjs";
import { expiryFromSeconds, tokenExpired, tokenNeedsRefresh } from "./integrations.mjs";
import { log, logError } from "./logger.mjs";
import { QR_PROVIDER, createQrWhatsAppClient } from "./qrGateway.mjs";

/**
 * Returns a client bound to this business's credentials, or null when the
 * business has no usable integration.
 *
 * Null is a real answer, not an error case to paper over: the caller must
 * report the failure rather than fall back to someone else's number.
 *
 * When no integration layer is wired at all (local runs and the tests
 * that predate it) the shared client is returned, because in that
 * configuration there is only one tenant and nothing to confuse it with.
 */
export async function clientForBusiness(businessId, { wa, integrations, embeddedSignup, qrGateway, templates }) {
  if (!integrations) return wa ?? null;
  if (!businessId) return null;

  let integration = await integrations.forBusiness(businessId);
  if (!integration?.phoneNumberId) return null;

  // The unofficial QR route sends from the business's own number through
  // the gateway. Still this business's own number, so the rule above holds.
  // Only while the gateway last reported it connected: a logged-out or
  // blocked number refuses here, visibly, instead of failing at WhatsApp.
  if (integration.provider === QR_PROVIDER) {
    if (integration.status !== "CONNECTED" || !qrGateway) {
      log("outbound_refused_qr_offline", { businessId, status: integration.status, gateway: Boolean(qrGateway) });
      return null;
    }
    return createQrWhatsAppClient({ gateway: qrGateway, businessId, templates });
  }

  let secrets = integrations.secretsOf(integration);
  if (!secrets?.accessToken) return null;

  // An expired token cannot send and cannot be refreshed. Refusing here
  // surfaces it as an undelivered send the owner can see, instead of a
  // Meta 401 that reads like an outage.
  if (tokenExpired(integration)) {
    log("outbound_refused_token_expired", { businessId });
    return null;
  }

  // Embedded Signup tokens last 60 days. Renew ahead of the expiry on the
  // way to a send: the business is demonstrably still using the product,
  // and no scheduler is needed. Best-effort — the current token still
  // works today, so a failed refresh must never block this send.
  if (embeddedSignup?.refreshToken && tokenNeedsRefresh(integration)) {
    try {
      const refreshed = await embeddedSignup.refreshToken(secrets.accessToken);
      if (refreshed.ok) {
        integration = await integrations.replaceAccessToken(
          integration,
          refreshed.accessToken,
          expiryFromSeconds(refreshed.expiresIn)
        );
        secrets = integrations.secretsOf(integration);
        log("integration_token_refreshed", { businessId });
      } else {
        log("integration_token_refresh_failed", { businessId, reason: refreshed.reason ?? null });
      }
    } catch (err) {
      logError("integration_token_refresh_error", err, { businessId });
    }
  }

  return createWhatsAppClientFor({
    phoneNumberId: integration.phoneNumberId,
    accessToken: secrets.accessToken,
  });
}

/**
 * The client a business's OWNER ALERTS go out on.
 *
 * Normally the business's own client. A business on the QR route is the
 * exception: its alert would go from the owner's number to the owner, and
 * WhatsApp doesn't notify anyone about a message to themselves. So its
 * alerts go from MissedCall's own official number (the deployment's
 * META_* client) using the approved `new_lead_alert` template. This is the
 * one deliberate use of the shared client for a tenant: the recipient is
 * the business's own owner, and the template names the business, so no
 * customer ever hears from another business's number.
 */
export async function ownerAlertClientForBusiness(businessId, deps) {
  const integration = deps.integrations && businessId ? await deps.integrations.forBusiness(businessId) : null;
  if (integration?.provider === QR_PROVIDER) {
    const official = deps.config?.META_ACCESS_TOKEN && deps.config?.META_PHONE_NUMBER_ID;
    if (!official || !deps.wa) {
      log("owner_alert_no_official_number", { businessId });
      return null;
    }
    return deps.wa;
  }
  return clientForBusiness(businessId, deps);
}

/**
 * A client that sends nothing and says so, for a business with no usable
 * integration.
 *
 * It exists so an inbound message is still recorded and the lead is still
 * created when we cannot reply: the failure belongs on the dashboard as an
 * undelivered notification, not in a dropped webhook. Its result shape
 * matches a failed Meta call, so every caller's existing "did this send?"
 * check already handles it.
 */
export function refusingClient(businessId, logFn) {
  const refuse = () => {
    logFn?.("outbound_refused_no_integration", { businessId });
    return Promise.resolve({ ok: false, status: 0, body: null });
  };
  return { sendText: refuse, sendTemplate: refuse };
}
