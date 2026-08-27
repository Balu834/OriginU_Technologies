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
  const conversation = store.getConversation(from) ?? freshConversation(from);
  const result = { emergency: false, leadCompleted: false };

  if (isEmergency(text) && !conversation.emergency) {
    conversation.emergency = true;
    result.emergency = true;
    await wa.sendText(from, fillTemplate(templates._conversation.emergency_safety, [config.OWNER_NAME]));

    if (!conversation.emergencyNotified) {
      conversation.emergencyNotified = true;
      const partialLead = createLead({ callerNumber: from, fields: conversation.fields, emergency: true });
      await wa.sendText(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(partialLead));
    }

    conversation.awaiting = null;
    conversation.updatedAt = new Date().toISOString();
    store.saveConversation(from, conversation);
    return result;
  }

  const found = applyAwaitingFallback(text, conversation.awaiting, extractFields(text));
  conversation.fields = { ...found, ...conversation.fields }; // never overwrite an already-known field

  const missing = nextMissingField(conversation.fields);

  if (!missing) {
    const lead = createLead({ callerNumber: from, fields: conversation.fields, emergency: conversation.emergency });
    store.saveLead(lead);
    conversation.completed = true;
    conversation.awaiting = null;
    result.leadCompleted = true;
    result.lead = lead;

    await wa.sendText(
      from,
      fillTemplate(templates._conversation.lead_confirmation, [conversation.fields.name || "there", config.OWNER_NAME])
    );
    if (!conversation.emergencyNotified) {
      await wa.sendText(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(lead));
    }
  } else {
    conversation.awaiting = missing;
    const question = templates._conversation[QUESTION_KEY[missing]];
    await wa.sendText(from, fillTemplate(question, [conversation.fields.name || ""]));
  }

  conversation.updatedAt = new Date().toISOString();
  store.saveConversation(from, conversation);
  return result;
}
