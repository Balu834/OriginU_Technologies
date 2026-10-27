import { verifySignature } from "../lib/whatsapp.mjs";
import { clientForBusiness, refusingClient } from "../lib/outbound.mjs";
import { businessContext } from "../lib/businesses.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { log, logError } from "../lib/logger.mjs";
import { toE164 } from "../lib/phone.mjs";

/**
 * How long after a missed call MissedCall may answer that caller on a
 * coexistence number (one the owner also uses in the WhatsApp Business app).
 * Outside it, a message is an ordinary chat and belongs to the owner.
 */
export const COEXISTENCE_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Webhook fields that only coexistence numbers send, and that need no reply. */
const COEXISTENCE_INFO_FIELDS = new Set(["history", "smb_app_state_sync"]);

/**
 * Whether the bot may answer this message on a coexistence number: only a
 * caller who gave a missed call within the window, and only until the owner
 * has replied to them from the app after that call.
 */
export function coexistenceMayReply({ lastMissedCallAt, lastOwnerReplyAt, now = Date.now() }) {
  if (!lastMissedCallAt || now - lastMissedCallAt > COEXISTENCE_REPLY_WINDOW_MS) return { ok: false, reason: "no_recent_missed_call" };
  if (lastOwnerReplyAt && lastOwnerReplyAt >= lastMissedCallAt) return { ok: false, reason: "owner_replied" };
  return { ok: true };
}

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
        // Lifecycle news for a coexistence number (owner disconnected the
        // app, number changed...). It carries no phone_number_id, so it is
        // recorded here rather than dropped as "unknown business".
        if (change.field === "account_update") {
          log("account_update_received", {
            event: String(change.value?.event ?? "").slice(0, 40),
            reason: String(change.value?.disconnection_info?.reason ?? "").slice(0, 40) || null,
          });
          continue;
        }

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
          // A "failed" receipt carries Meta's reason (payment method missing,
          // recipient unreachable, ...). Log it before the lookup below:
          // without the code an accepted-then-failed send is undiagnosable.
          if (status.status === "failed") {
            const e = status.errors?.[0] ?? {};
            log("delivery_failed", {
              metaCode: e.code ?? null,
              metaTitle: e.title ?? null,
              metaMessage: e.message ?? null,
              metaDetails: e.error_data?.details ?? null,
            });
          }
          try {
            const stored = await tenantStore.findMessageByProviderId?.(status.id);
            if (!stored) continue;
            await tenantStore.updateMessage({
              ...stored,
              deliveryStatus: status.status,
              metadata: { ...stored.metadata, statusAt: new Date().toISOString() },
            });
            log("delivery_status_recorded", { status: status.status });

            // The API accepting a lead alert is not the owner receiving it.
            // When Meta later reports it failed, the lead goes back to
            // "owner not notified" so the dashboard flags it for a retry,
            // instead of claiming a delivery that never happened.
            if (status.status === "failed" && stored.senderType === "owner" && stored.leadId && tenantStore.getLead) {
              const lead = await tenantStore.getLead(stored.leadId);
              if (lead && lead.ownerNotified !== false) {
                await tenantStore.saveLead({ ...lead, ownerNotified: false, updatedAt: new Date().toISOString() });
                log("owner_notification_failed_late", { leadId: lead.id });
              }
            }
          } catch (err) {
            logError("delivery_status_error", err, {});
          }
        }

        // Contact and chat-history syncs for a coexistence number. Nothing
        // to answer and nothing to store: the owner's history stays theirs.
        if (COEXISTENCE_INFO_FIELDS.has(change.field)) {
          log("coexistence_sync_received", { field: change.field, businessId: business?.id ?? null });
          continue;
        }

        // A message the owner sent from their own WhatsApp Business app. It
        // is never a customer message; it means the owner has taken over
        // that chat, so the bot steps back for that customer.
        for (const echo of change.value?.message_echoes ?? []) {
          try {
            const to = String(echo?.to ?? "");
            if (!to) continue;
            const customer = to.startsWith("+") ? to : `+${to}`;
            const at = Number(echo.timestamp) ? Number(echo.timestamp) * 1000 : Date.now();
            if (tenantStore.markOwnerReply) await tenantStore.markOwnerReply(customer, at);
            log("owner_replied_from_app", { businessId: business?.id ?? null });
          } catch (err) {
            logError("message_echo_error", err, {});
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

            // The owner messaging their own business number (to keep alerts
            // flowing, or to test) is not a customer, and must not be asked
            // "what do you need?" or turned into a lead about themselves.
            // Compared in E.164 so a legacy unprefixed owner number still matches.
            if (business?.ownerWhatsApp && from === (toE164(business.ownerWhatsApp) ?? business.ownerWhatsApp)) {
              log("owner_message_ignored", { businessId: business.id });
              continue;
            }

            // On a number the owner also uses in the WhatsApp Business app,
            // most messages are ordinary chats with the owner. Only someone
            // who just gave a missed call is MissedCall's to answer, and only
            // until the owner replies to them from the app.
            if (integration?.coexistence) {
              const decision = coexistenceMayReply({
                lastMissedCallAt: tenantStore.lastMissedCallAt ? await tenantStore.lastMissedCallAt(from) : null,
                lastOwnerReplyAt: tenantStore.lastOwnerReplyAt ? await tenantStore.lastOwnerReplyAt(from) : null,
              });
              if (!decision.ok) {
                log("coexistence_message_left_to_owner", { businessId: business?.id, reason: decision.reason });
                continue;
              }
            }

            log("customer_reply_received", { from, businessId: business?.id });

            const result = await handleInboundMessage(
              { from, text: msg.text.body, messageId: msg.id, messageType: msg.type, timestamp: msg.timestamp },
              // The routed business's own configuration. Built from the
              // business resolved by phone_number_id, so one tenant's
              // services, areas or greeting can never reach another's reply.
              { store: tenantStore, wa: tenantWa, config: tenantConfig, templates,
                context: business ? businessContext(business) : null }
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
