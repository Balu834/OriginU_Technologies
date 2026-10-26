/**
 * The WhatsApp conversation state machine: one customer reply in, zero or
 * more outbound messages out (safety ack / next question / confirmation),
 * plus an owner notification once the lead is complete or an emergency
 * signal fires. Kept as pure-ish functions over injected `deps` so it can
 * be tested without a real WhatsApp client or HTTP server.
 */
import crypto from "node:crypto";
import { isEmergency } from "./emergency.mjs";
import { extractFields, applyAwaitingFallback, nextMissingField } from "./extract.mjs";
import { createLead, formatOwnerNotification } from "./leads.mjs";
import { logError } from "./logger.mjs";
import { createMessage, providerMessageId } from "./messages.mjs";
import { greetingLine, servicesLine, compose, ownerNameFor } from "./voice.mjs";
import { verticalConfig } from "./verticals.mjs";
import { sendOwnerAlert } from "./ownerAlert.mjs";

// A short thank-you after the lead is done is politeness, not a new job.
const COURTESY_RE = /^\s*(?:ok(?:ay)?|k|thanks?|thank you|thanku|thx|ty|sure|great|cool|done|fine|got it|noted|👍|🙏|🙂|😊)(?:[\s!.,]+(?:ok(?:ay)?|thanks?|thank you|sir|madam|ji|bro|so much|a lot|👍|🙏|🙂|😊))*[\s!.]*$/iu;

function fillTemplate(str, params) {
  return params.reduce((s, p, i) => s.replaceAll(`{{${i + 1}}}`, p), str);
}

function freshConversation(callerNumber) {
  const now = new Date().toISOString();
  return {
    callerNumber,
    // A stable id for THIS run of the conversation. Every message written
    // during the run carries it, so when a lead is finally created the
    // messages that belong to it can be named exactly — no ordering, no
    // timestamps, no guessing.
    runId: crypto.randomUUID(),
    leadId: null,
    fields: {},
    // The missed-call template already asked "what you need and your area",
    // so the first reply answers the problem. Without this the reply went
    // unclaimed, the bot asked for the problem again, and every later answer
    // landed one field off (the area saved as the problem, the name as the area).
    awaiting: "problem",
    emergency: false,
    emergencyNotified: false,
    greeted: false,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Stamps a lead id onto the messages of the run that produced it.
 *
 * The messages of a conversation are written before the lead exists —
 * the customer answers four questions and only the last one completes it.
 * Rather than guess afterwards which messages belonged to that lead, each
 * message already carries the run id it was written under, so this names
 * them exactly.
 *
 * Only messages of THIS run, and only ones not already attributed, are
 * touched. A second lead from the same number runs under a different run
 * id and is never reached by this.
 */
async function attributeRunToLead({ store, conversationId, runId, leadId }) {
  if (!runId || !store.listMessages || !store.updateMessage) return 0;

  const messages = await store.listMessages(conversationId);
  let attributed = 0;
  for (const message of messages) {
    if (message.conversationRunId !== runId || message.leadId) continue;
    await store.updateMessage({ ...message, leadId });
    attributed++;
  }
  return attributed;
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
  const existing = await store.getConversation(from);
  // A new missed call since this conversation last moved means the customer
  // is starting over: they were sent a fresh "what do you need?" template,
  // so their reply answers that, not whatever the abandoned run was still
  // waiting for (otherwise "ac not cooling" gets taken as their name).
  const lastMissedCall = store.lastMissedCallAt ? await store.lastMissedCallAt(from) : null;
  const restartedByNewCall = Boolean(
    existing && lastMissedCall && lastMissedCall > Date.parse(existing.updatedAt)
  );
  // A reply after the lead is already complete is a new job, not more
  // detail for the old one — start clean rather than re-completing (and
  // re-notifying the owner about) the same lead on every later message.
  const vertical = verticalConfig(context);
  const lines = templates[vertical.templatesKey] ?? templates._conversation;

  // "Thanks!" after the lead is complete is not a new job. Record it under
  // the finished run so the owner can see it, and send nothing: starting a
  // new questionnaire here created a junk second lead and a second alert.
  if (existing?.completed && !restartedByNewCall && COURTESY_RE.test(String(text ?? ""))) {
    if (store.saveMessage) {
      await store.saveMessage(
        createMessage({
          conversationId: from,
          conversationRunId: existing.runId ?? null,
          leadId: existing.leadId ?? null,
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
    return { emergency: false, leadCompleted: false, courtesy: true };
  }

  const conversation = !existing || existing.completed || restartedByNewCall ? freshConversation(from) : existing;
  // Conversations written before run ids existed have none; they stay
  // null and their messages remain unattributable, which is the honest
  // outcome rather than inventing an association after the fact.
  const runId = conversation.runId ?? null;

  /** Records one outbound message alongside sending it, capturing Meta's id. */
  const sendAndRecord = async (to, body, senderType, leadId = null, alertLead = null) => {
    // Owner alerts go out as the lead-alert template (no 24-hour window),
    // falling back to this same text; everything else is plain text.
    let via = "text";
    let result;
    if (alertLead) {
      ({ result, via } = await sendOwnerAlert(wa, {
        to,
        lead: alertLead,
        businessName: context?.name || config.BUSINESS_NAME,
        language: config.WHATSAPP_TEMPLATE_LANGUAGE || "en",
        text: body,
      }));
    } else {
      result = await wa.sendText(to, body);
    }
    if (store.saveMessage) {
      await store.saveMessage(
        createMessage({
          conversationId: from,
          conversationRunId: runId,
          leadId,
          direction: "outbound",
          senderType,
          customerPhone: from,
          messageId: providerMessageId(result),
          text: body,
          // Acceptance by the API is not delivery; that only arrives later
          // via a status webhook, so this stays null until it does.
          deliveryStatus: null,
          metadata: { accepted: result?.ok !== false, to, ...(alertLead ? { via } : {}) },
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
        conversationRunId: runId,
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

  const result = { emergency: false, leadCompleted: false };

  // Extract before the emergency check so a message like "the socket is
  // sparking" still contributes "socket" to the lead, not just the alert.
  const found = applyAwaitingFallback(text, conversation.awaiting, extractFields(text));
  conversation.fields = { ...found, ...conversation.fields }; // never overwrite an already-known field

  // The business's own name for the owner, falling back to the
  // deployment-wide value when no business context was routed in.
  const ownerName = ownerNameFor(context, config.OWNER_NAME);

  if (vertical.emergencyChecks && isEmergency(text) && !conversation.emergency) {
    conversation.emergency = true;
    result.emergency = true;
    // No greeting on a safety message. Someone reporting sparking does
    // not need an introduction first, and a conversation that opens this
    // way never gets one — the register is already set.
    conversation.greeted = true;
    await sendAndRecord(from, fillTemplate(lines.emergency_safety, [ownerName]), "assistant");

    if (!conversation.emergencyNotified) {
      conversation.emergencyNotified = true;
      // The partial lead is a formatting vehicle only — it is never
      // stored. Stamping its id on the message would point at a lead that
      // does not exist and can never be deleted, so this stays unassigned
      // and is claimed by the backfill below if the lead completes.
      const partialLead = createLead({ callerNumber: from, fields: conversation.fields, emergency: true });
      await sendAndRecord(config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(partialLead), "owner", null, partialLead);
    }
    // Fall through into the normal ask/complete flow below — the customer
    // still gets asked whatever's missing (or gets the confirmation, if
    // this message happened to complete the lead), just after the safety
    // message rather than instead of it. Going silent here would leave
    // `awaiting` unset, and the customer's next reply — meant to answer
    // whatever question would have come next — would have nothing to land
    // in and get misread as an answer to a later question instead.
  }

  const missing = nextMissingField(conversation.fields, vertical.fieldOrder);

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

  // The explicit conversation-to-lead link, persisted alongside the run id
  // the messages already carry.
  if (lead) conversation.leadId = lead.id;

  conversation.updatedAt = new Date().toISOString();
  await store.saveConversation(from, conversation);
  if (lead) {
    await store.saveLead(lead);
    await attributeRunToLead({ store, conversationId: from, runId, leadId: lead.id });
  }

  // Everything below is best-effort delivery. State is already durable.
  if (lead) {
    await sendAndRecord(
      from,
      compose(
        greeting,
        fillTemplate(lines.lead_confirmation, [conversation.fields.name || "there", ownerName])
      ),
      "assistant",
      lead.id
    );

    // Always notify on completion, even after an earlier emergency alert —
    // that alert carried none of the name/area/problem detail this one does.
    const notified = await sendAndRecord(
      config.MOHAMED_WHATSAPP_NUMBER, formatOwnerNotification(lead), "owner", lead.id, lead
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
    const question = lines[vertical.questionKeys[missing]];
    // What the business does attaches to the question about what's wrong
    // (empty unless the business configured services). The area question is
    // asked plainly: listing "We cover X and Y" right before the customer
    // names some other area read as a refusal, and whether to take a job
    // outside the usual areas is the owner's call, made from the lead.
    const detail = missing === "problem" ? servicesLine(context) : "";

    await sendAndRecord(
      from,
      compose(greeting, fillTemplate(question, [conversation.fields.name || ""]), detail),
      "assistant"
    );
  }

  return result;
}
