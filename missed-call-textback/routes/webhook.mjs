import { verifySignature } from "../lib/whatsapp.mjs";
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
  const { config, store, wa, templates } = deps;

  const valid = verifySignature(ctx.rawBody, ctx.headers["x-hub-signature-256"], config.META_APP_SECRET);
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
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          try {
            if (store.hasProcessedMessage(msg.id)) {
              log("duplicate_message_ignored", { messageId: msg.id });
              continue;
            }
            store.markMessageProcessed(msg.id);

            if (msg.type !== "text") {
              log("unsupported_message_type_ignored", { type: msg.type });
              continue;
            }

            const from = msg.from.startsWith("+") ? msg.from : `+${msg.from}`;
            log("customer_reply_received", { from });

            const result = await handleInboundMessage({ from, text: msg.text.body }, { store, wa, config, templates });
            if (result.emergency) log("emergency_detected", { from });
            if (result.leadCompleted) log("lead_completed", { from, leadId: result.lead?.id });
          } catch (err) {
            logError("message_processing_error", err, {});
          }
        }
      }
    }
  };

  return { status: 200, body: { received: true }, afterAck };
}
