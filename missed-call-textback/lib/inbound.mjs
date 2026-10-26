/**
 * One inbound customer message, already attributed to a business.
 *
 * Shared by the Meta webhook (routes/webhook.mjs) and the QR gateway's
 * events (routes/qrEvents.mjs), so both routes apply the same duplicate
 * check, the same "the owner isn't a customer" rule, the same
 * conversation, and the same lead metering. They differ only in how a
 * message reaches here and which clients send the replies.
 */
import { handleInboundMessage } from "./conversation.mjs";
import { businessContext } from "./businesses.mjs";
import { log } from "./logger.mjs";
import { toE164 } from "./phone.mjs";

/**
 * `msg` is { id, type, from, text, timestamp }, `from` in E.164.
 * Returns what happened, for logs and tests.
 */
export async function processInboundMessage(msg, { business, tenantStore, tenantWa, alertWa = null, tenantConfig, deps }) {
  if (!msg.id) {
    log("message_missing_id", { type: msg.type });
  } else {
    if (await tenantStore.hasProcessedMessage(msg.id)) {
      log("duplicate_message_ignored", { messageId: msg.id });
      return { skipped: "duplicate" };
    }
    await tenantStore.markMessageProcessed(msg.id);
  }

  if (msg.type !== "text") {
    log("unsupported_message_type_ignored", { type: msg.type });
    return { skipped: "type" };
  }

  const from = msg.from;

  // The owner messaging their own business number (to keep alerts
  // flowing, or to test) is not a customer, and must not be asked
  // "what do you need?" or turned into a lead about themselves.
  // Compared in E.164 so a legacy unprefixed owner number still matches.
  if (business?.ownerWhatsApp && from === (toE164(business.ownerWhatsApp) ?? business.ownerWhatsApp)) {
    log("owner_message_ignored", { businessId: business.id });
    return { skipped: "owner" };
  }

  log("customer_reply_received", { from, businessId: business?.id });

  const result = await handleInboundMessage(
    { from, text: msg.text, messageId: msg.id, messageType: msg.type, timestamp: msg.timestamp },
    // The routed business's own configuration. Built from the business
    // resolved server-side, so one tenant's services, areas or greeting
    // can never reach another's reply.
    { store: tenantStore, wa: tenantWa, alertWa, config: tenantConfig, templates: deps.templates,
      context: business ? businessContext(business) : null }
  );
  if (result.emergency) log("emergency_detected", { from });
  if (result.leadCompleted) {
    log("lead_completed", { from, leadId: result.lead?.id });
    // Metered, not gated. A redelivery never reaches this line — the
    // idempotency check above drops it — so retries cannot inflate the
    // count. Deliberately no limit check here: refusing mid-conversation
    // would strand a customer who has already answered our questions, and
    // discard a lead the business has effectively already earned.
    if (business && deps.usage) await deps.usage.record(business.id, "leads", 1);
  }
  return result;
}

/** The per-business config overrides both inbound routes reply with. */
export function tenantConfigFor(config, business) {
  return business
    ? { ...config, BUSINESS_NAME: business.name, OWNER_NAME: business.ownerName, MOHAMED_WHATSAPP_NUMBER: business.ownerWhatsApp }
    : config;
}
