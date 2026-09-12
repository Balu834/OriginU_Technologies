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

  if (!missing) {
    const lead = createLead({ callerNumber: from, fields: conversation.fields, emergency: conversation.emergency });
    await store.saveLead(lead);
    conversation.completed = true;
    conversation.awaiting = null;
    result.leadCompleted = true;
    result.lead = lead;

    await wa.sendText(
      from,
      fillTemplate(templates._conversation.lead_confirmation, [conversation.fields.name || "there", config.OWNER_NAME])
    );
    // Always send the completed-lead notification, even after an earlier
    // emergency alert — that alert had none of the name/area/problem
    // details this one carries, so it's not a duplicate.
    await wa.sendText(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(lead));
  } else {
    conversation.awaiting = missing;
    const question = templates._conversation[QUESTION_KEY[missing]];
    await wa.sendText(from, fillTemplate(question, [conversation.fields.name || ""]));
  }

  conversation.updatedAt = new Date().toISOString();
  await store.saveConversation(from, conversation);
  return result;
}
