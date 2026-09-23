/**
 * The conversation transcript.
 *
 * Until now only inbound message *ids* were kept, for idempotency — the
 * words themselves were never stored. That's fine until someone asks why
 * a lead says what it says, or a customer disputes what was promised, at
 * which point there is no record at all.
 *
 * Two deliberate distinctions:
 *
 * - `senderType: "owner"` marks the notification we send the business.
 *   It shares the customer's conversation only by association; it is NOT
 *   part of what the customer saw, and the transcript view must never
 *   render it as though it were.
 * - `deliveryStatus` is what Meta later told us happened to the message,
 *   which is not the same as the API having accepted it. An accepted send
 *   that never arrives is exactly the failure worth being able to see, so
 *   acceptance alone never counts as delivered.
 */
import crypto from "node:crypto";

export const DIRECTIONS = ["inbound", "outbound"];
export const SENDER_TYPES = ["customer", "assistant", "owner", "system"];
export const DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"];

/** Meta's own type strings, narrowed to the set we record. */
export function normaliseMessageType(type) {
  const known = ["text", "image", "audio", "document"];
  return known.includes(type) ? type : "other";
}

export function createMessage({
  businessId = "",
  conversationId,
  // Which run of the conversation this message belongs to. A customer
  // rings more than once, so one conversationId spans several runs and
  // each run becomes at most one lead. This is what makes ownership
  // explicit instead of inferred from position or timestamp.
  conversationRunId = null,
  leadId = null,
  direction,
  senderType,
  customerPhone,
  messageId = null,
  messageType = "text",
  text = "",
  timestamp = null,
  metadata = {},
  deliveryStatus = null,
}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    businessId,
    conversationId,
    conversationRunId,
    leadId,
    direction,
    senderType,
    customerPhone,
    messageId,
    messageType: normaliseMessageType(messageType),
    text,
    // Meta sends a unix-seconds string; keep ISO for everything we store.
    timestamp: timestamp ? new Date(Number(timestamp) * 1000).toISOString() : now,
    metadata,
    deliveryStatus,
    createdAt: now,
  };
}

/** Pulls the provider message id out of a send result, when the API returned one. */
export function providerMessageId(sendResult) {
  return sendResult?.body?.messages?.[0]?.id ?? null;
}

/** Only what the customer actually exchanged with us — owner alerts excluded. */
export function customerVisible(messages) {
  return messages.filter((m) => m.senderType === "customer" || m.senderType === "assistant");
}
