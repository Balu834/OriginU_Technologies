import { verifySignature } from "../lib/whatsapp.mjs";
import { clientForBusiness, refusingClient } from "../lib/outbound.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { log, logError } from "../lib/logger.mjs";

/** GET /webhook — Meta's one-time verification handshake. */
export function verifyWebhookGet(ctx, { config }) {
  const mode = ctx.query.get("hub.mode");
  const token = ctx.query.get("hub.verify_token");
  const challenge = ctx.query.get("hub.challenge");

  if (mode === "subscribe" && token === config.META_VERIFY_TOKEN) {
    return { status: 200, rawText: challenge ?? "" };
  }
  return { status: 403, body: { error: "verification failed" } };
}

/**
 * POST /webhook — inbound WhatsApp events. Verifies the signature, then
 * acks immediately (Meta retries aggressively on slow/failed responses)
 * and does the actual work in `afterAck`, which the server runs once the
 * response has been sent. One bad message never takes down the others —
 * each is wrapped in its own try/catch.
 */
export function handleWebhookPost(ctx, deps) {
  const { config, store, wa, templates, businesses, integrations, verifySecrets } = deps;

  // Signature is checked against the app secret before the payload can be
  // parsed, so the business is not yet known. Meta signs with the APP
  // secret (one per app, not per number), which is why this legitimately
  // stays app-level — see the Meta limitation noted in the final report.
  const appSecret = verifySecrets?.appSecret ?? config.META_APP_SECRET;
  const valid = verifySignature(ctx.rawBody, ctx.headers["x-hub-signature-256"], appSecret);
  if (!valid) {
    logError("webhook_invalid_signature", new Error("signature mismatch"), {});
    return { status: 403, body: { error: "invalid signature" } };
  }

  let payload;
  try {
    payload = JSON.parse(ctx.rawBody.toString("utf8") || "{}");
  } catch {
    payload = null;
  }

  const afterAck = async () => {
    if (!payload) {
      logError("webhook_malformed_payload", new Error("invalid JSON"), {});
      return;
    }
    // Shape-only summary, logged for every delivery. Meta sends status
    // receipts and inbound messages to the same URL, and without this the
    // two are indistinguishable in the request log — which makes "did the
    // customer's reply actually arrive?" impossible to answer from logs.
    // Deliberately counts and types only: no message text, no PII.
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        log("webhook_payload_received", {
          field: change.field,
          messages: (value.messages ?? []).length,
          statuses: (value.statuses ?? []).length,
          messageTypes: (value.messages ?? []).map((m) => m.type).join(",") || "-",
          statusTypes: (value.statuses ?? []).map((s) => s.status).join(",") || "-",
          errors: (value.errors ?? []).length,
        });
      }
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Attribute the delivery to a business before touching any data.
        // Meta tells us which of our numbers the customer messaged; if it
        // isn't one we know, the event is dropped rather than guessed at —
        // defaulting to "the first business" is how tenants leak into
        // each other.
        const phoneNumberId = change.value?.metadata?.phone_number_id;

        // Server-side mapping only: phone_number_id -> integration ->
        // businessId. Nothing about the request body, query string or any
        // logged-in user participates in this decision.
        let business = null;
        let integration = null;
        if (integrations) {
          integration = await integrations.byPhoneNumberId(phoneNumberId);
          business = integration ? businesses?.byId(integration.businessId) ?? null : null;
        } else {
          business = businesses?.byPhoneNumberId(phoneNumberId) ?? null;
        }

        if ((businesses || integrations) && !business) {
          // Unattributable: dropped, never filed under default.
          log("webhook_unknown_business", { phoneNumberId: phoneNumberId ? "present" : "missing" });
          continue;
        }
        const tenantStore = business ? scopedToBusiness(store, business.id) : store;

        // Replies go out on the credentials of the business the message
        // arrived for — never a shared client. Resolved through the same
        // helper the missed-call and retry paths use, so the three cannot
        // drift apart again; two of them once reached for the global
        // client and sent on the default tenant's number.
        // A business we cannot send for gets a client that refuses rather
        // than the shared one: the customer's message is still recorded and
        // the lead still created, and the undelivered reply shows up on the
        // dashboard instead of arriving from someone else's number.
        const tenantWa = business
          ? ((await clientForBusiness(business.id, deps)) ?? refusingClient(business.id, log))
          : wa;
        const tenantConfig = business
          ? { ...config, BUSINESS_NAME: business.name, OWNER_NAME: business.ownerName,
              MOHAMED_WHATSAPP_NUMBER: business.ownerWhatsApp }
          : config;

        // Delivery receipts for messages we sent. These say what actually
        // happened to a message, as opposed to the API having accepted it.
        for (const status of change.value?.statuses ?? []) {
          try {
            const stored = await tenantStore.findMessageByProviderId?.(status.id);
            if (!stored) continue;
            await tenantStore.updateMessage({
              ...stored,
              deliveryStatus: status.status,
              metadata: { ...stored.metadata, statusAt: new Date().toISOString() },
            });
            log("delivery_status_recorded", { status: status.status });
          } catch (err) {
            logError("delivery_status_error", err, {});
          }
        }

        for (const msg of change.value?.messages ?? []) {
          try {
            if (!msg.id) {
              log("message_missing_id", { type: msg.type });
            } else {
              if (await tenantStore.hasProcessedMessage(msg.id)) {
                log("duplicate_message_ignored", { messageId: msg.id });
                continue;
              }
              await tenantStore.markMessageProcessed(msg.id);
            }

            if (msg.type !== "text") {
              log("unsupported_message_type_ignored", { type: msg.type });
              continue;
            }

            const from = msg.from.startsWith("+") ? msg.from : `+${msg.from}`;
            log("customer_reply_received", { from, businessId: business?.id });

            const result = await handleInboundMessage(
              { from, text: msg.text.body, messageId: msg.id, messageType: msg.type, timestamp: msg.timestamp },
              { store: tenantStore, wa: tenantWa, config: tenantConfig, templates }
            );
            if (result.emergency) log("emergency_detected", { from });
            if (result.leadCompleted) {
              log("lead_completed", { from, leadId: result.lead?.id });
              // Metered, not gated. A redelivery never reaches this line —
              // the idempotency check above drops it — so Meta's retries
              // cannot inflate the count. Deliberately no limit check
              // here: refusing mid-conversation would strand a customer
              // who has already answered our questions, and discard a lead
              // the business has effectively already earned.
              if (business && deps.usage) await deps.usage.record(business.id, "leads", 1);
            }
          } catch (err) {
            logError("message_processing_error", err, {});
          }
        }
      }
    }
  };

  return { status: 200, body: { received: true }, afterAck };
}
