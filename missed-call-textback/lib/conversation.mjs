/**
 * The WhatsApp conversation state machine: one customer reply in, zero or
 * more outbound messages out (safety ack / next question / confirmation),
 * plus an owner notification once the lead is complete or an emergency
 * signal fires. Kept as pure-ish functions over injected `deps` so it can
 * be tested without a real WhatsApp client or HTTP server.
 */
import { isEmergency } from "./emergency.mjs";
import { extractFields, applyAwaitingFallback, nextMissingField } from "./extract.mjs";
import { createLead, formatOwnerNotification } from "./leads.mjs";
import { logError } from "./logger.mjs";

const QUESTION_KEY = { problem: "ask_problem", area: "ask_area", name: "ask_name", urgency: "ask_urgency" };

function fillTemplate(str, params) {
  return params.reduce((s, p, i) => s.replaceAll(`{{${i + 1}}}`, p), str);
}

function freshConversation(callerNumber) {
  const now = new Date().toISOString();
  return {
    callerNumber,
    fields: {},
    awaiting: null,
    emergency: false,
    emergencyNotified: false,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Handles one inbound WhatsApp text message. Mutates nothing outside the
 * store; returns a summary of what happened for logging/tests.
 */
export async function handleInboundMessage({ from, text }, { store, wa, config, templates }) {
  const existing = await store.getConversation(from);
  // A reply after the lead is already complete is a new job, not more
  // detail for the old one — start clean rather than re-completing (and
  // re-notifying the owner about) the same lead on every later message.
  const conversation = !existing || existing.completed ? freshConversation(from) : existing;
  const result = { emergency: false, leadCompleted: false };

  // Extract before the emergency check so a message like "the socket is
  // sparking" still contributes "socket" to the lead, not just the alert.
  const found = applyAwaitingFallback(text, conversation.awaiting, extractFields(text));
  conversation.fields = { ...found, ...conversation.fields }; // never overwrite an already-known field

  if (isEmergency(text) && !conversation.emergency) {
    conversation.emergency = true;
    result.emergency = true;
    await wa.sendText(from, fillTemplate(templates._conversation.emergency_safety, [config.OWNER_NAME]));

    if (!conversation.emergencyNotified) {
      conversation.emergencyNotified = true;
      const partialLead = createLead({ callerNumber: from, fields: conversation.fields, emergency: true });
      await wa.sendText(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(partialLead));
    }
    // Fall through into the normal ask/complete flow below — the customer
    // still gets asked whatever's missing (or gets the confirmation, if
    // this message happened to complete the lead), just after the safety
    // message rather than instead of it. Going silent here would leave
    // `awaiting` unset, and the customer's next reply — meant to answer
    // whatever question would have come next — would have nothing to land
    // in and get misread as an answer to a later question instead.
  }

  const missing = nextMissingField(conversation.fields);

  // Decide the whole next state, then persist it BEFORE any outbound send.
  // The webhook marks a message id processed before calling us, so Meta's
  // retry of the same message is skipped as a duplicate — if we only saved
  // after sending, a transient WhatsApp failure would discard what the
  // customer just told us and no retry would ever recover it.
  let lead = null;
  if (!missing) {
    lead = createLead({ callerNumber: from, fields: conversation.fields, emergency: conversation.emergency });
    conversation.completed = true;
    conversation.awaiting = null;
    result.leadCompleted = true;
    result.lead = lead;
  } else {
    conversation.awaiting = missing;
  }

  conversation.updatedAt = new Date().toISOString();
  await store.saveConversation(from, conversation);
  if (lead) await store.saveLead(lead);

  // Everything below is best-effort delivery. State is already durable.
  if (lead) {
    await wa.sendText(
      from,
      fillTemplate(templates._conversation.lead_confirmation, [conversation.fields.name || "there", config.OWNER_NAME])
    );

    // Always notify on completion, even after an earlier emergency alert —
    // that alert carried none of the name/area/problem detail this one does.
    const notified = await wa.sendText(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(lead));

    // A lead the owner never hears about is the one failure that destroys
    // this product's whole value, so record it rather than letting it pass
    // silently — the dashboard surfaces any lead still marked undelivered.
    const ownerNotified = notified?.ok !== false;
    if (!ownerNotified) {
      logError("owner_notification_failed", new Error(`status ${notified?.status ?? "unknown"}`), { leadId: lead.id });
    }
    await store.saveLead({ ...lead, ownerNotified, updatedAt: new Date().toISOString() });
    result.ownerNotified = ownerNotified;
  } else {
    const question = templates._conversation[QUESTION_KEY[missing]];
    await wa.sendText(from, fillTemplate(question, [conversation.fields.name || ""]));
  }

  return result;
}
