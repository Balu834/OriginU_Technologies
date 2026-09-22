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
export async function clientForBusiness(businessId, { wa, integrations }) {
  if (!integrations) return wa ?? null;
  if (!businessId) return null;

  const integration = await integrations.forBusiness(businessId);
  if (!integration?.phoneNumberId) return null;

  const secrets = integrations.secretsOf(integration);
  if (!secrets?.accessToken) return null;

  return createWhatsAppClientFor({
    phoneNumberId: integration.phoneNumberId,
    accessToken: secrets.accessToken,
  });
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
