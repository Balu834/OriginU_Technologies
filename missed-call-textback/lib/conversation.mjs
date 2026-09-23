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
import { createMessage, providerMessageId } from "./messages.mjs";
import { greetingLine, servicesLine, areasLine, compose, ownerNameFor } from "./voice.mjs";

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
    greeted: false,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Handles one inbound WhatsApp text message. Mutates nothing outside the
 * store; returns a summary of what happened for logging/tests.
 */
export async function handleInboundMessage(
  { from, text, messageId = null, messageType = "text", timestamp = null },
  // `context` is the routed business's own configuration, built by the
  // webhook via businessContext(). It is never derived from the customer's
  // message, and it is optional: without it every composed line is empty
  // and the conversation behaves exactly as it did before.
  { store, wa, config, templates, context = null }
) {
  /** Records one outbound message alongside sending it, capturing Meta's id. */
  const sendAndRecord = async (to, body, senderType, leadId = null) => {
    const result = await wa.sendText(to, body);
    if (store.saveMessage) {
      await store.saveMessage(
        createMessage({
          conversationId: from,
          leadId,
          direction: "outbound",
          senderType,
          customerPhone: from,
          messageId: providerMessageId(result),
          text: body,
          // Acceptance by the API is not delivery; that only arrives later
          // via a status webhook, so this stays null until it does.
          deliveryStatus: null,
          metadata: { accepted: result?.ok !== false, to },
        })
      );
    }
    return result;
  };

  // Record what the customer said before anything else can fail — the
  // transcript is the record of record, and losing it to a downstream
  // error would defeat the point of keeping one.
  if (store.saveMessage) {
    await store.saveMessage(
      createMessage({
        conversationId: from,
        direction: "inbound",
        senderType: "customer",
        customerPhone: from,
        messageId,
        messageType,
        text,
        timestamp,
      })
    );
  }

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

  // The business's own name for the owner, falling back to the
  // deployment-wide value when no business context was routed in.
  const ownerName = ownerNameFor(context, config.OWNER_NAME);

  if (isEmergency(text) && !conversation.emergency) {
    conversation.emergency = true;
    result.emergency = true;
    // No greeting on a safety message. Someone reporting sparking does
    // not need an introduction first, and a conversation that opens this
    // way never gets one — the register is already set.
    conversation.greeted = true;
    await sendAndRecord(from, fillTemplate(templates._conversation.emergency_safety, [ownerName]), "assistant");

    if (!conversation.emergencyNotified) {
      conversation.emergencyNotified = true;
      const partialLead = createLead({ callerNumber: from, fields: conversation.fields, emergency: true });
      await sendAndRecord(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(partialLead), "owner", partialLead.id);
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

  // The business introduces itself once, on its first reply, and never
  // again in the same conversation. Decided here so the flag is part of
  // the state persisted below — otherwise a send failure would replay the
  // greeting on the customer's next message.
  const greeting = conversation.greeted ? "" : greetingLine(context);
  if (!conversation.greeted) conversation.greeted = true;

  conversation.updatedAt = new Date().toISOString();
  await store.saveConversation(from, conversation);
  if (lead) await store.saveLead(lead);

  // Everything below is best-effort delivery. State is already durable.
  if (lead) {
    await sendAndRecord(
      from,
      compose(
        greeting,
        fillTemplate(templates._conversation.lead_confirmation, [conversation.fields.name || "there", ownerName])
      ),
      "assistant",
      lead.id
    );

    // Always notify on completion, even after an earlier emergency alert —
    // that alert carried none of the name/area/problem detail this one does.
    const notified = await sendAndRecord(
      config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(lead), "owner", lead.id
    );

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
    // Business context attaches to the question it belongs with: what we
    // do when asking what's wrong, where we work when asking the area.
    // Both are empty strings unless the business configured them, so a
    // business that configures nothing sends exactly the message this
    // product sent before any of this existed.
    const detail = missing === "problem" ? servicesLine(context)
      : missing === "area" ? areasLine(context)
        : "";

    await sendAndRecord(
      from,
      compose(greeting, fillTemplate(question, [conversation.fields.name || ""]), detail),
      "assistant"
    );
  }

  return result;
}
