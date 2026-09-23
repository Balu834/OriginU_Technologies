/**
 * Deleting one lead and the records that provably belong to it.
 *
 * The hard part is not deletion, it is OWNERSHIP. The same customer rings
 * more than once, so one phone number accumulates several leads over
 * time, and every one of them shares a single conversation key and a
 * single transcript list. Deleting by conversation key would take the
 * other leads' records with it — that mistake has already been made once
 * against production data by hand, and this module exists so it cannot be
 * made again through the product.
 *
 * THE OWNERSHIP RULE:
 *
 * A message is deleted only when `message.leadId === targetLeadId`. That
 * is the only evidence this module will act on, and there is deliberately
 * no timestamp or list-position reasoning anywhere in it.
 *
 * lib/conversation.mjs makes that evidence complete. Each run of a
 * conversation carries a `runId`, every message is written with the run
 * it belongs to, and when the run produces a lead those messages are
 * stamped with its id — so the customer's own texts and the assistant's
 * questions are attributed too, not just the confirmation and the owner
 * alerts.
 *
 * Messages with `leadId: null` are still PRESERVED. That now means only
 * the genuinely unattributable: records written before run ids existed,
 * and runs that never produced a lead. A wrong guess here silently
 * destroys a different lead's transcript, so this module takes the
 * conservative failure every time.
 *
 * The conversation key and the transcript list are removed only when
 * nothing is left that depends on them: no other lead on that number, and
 * no surviving messages.
 */
import { log } from "./logger.mjs";

/**
 * Works out exactly what would be deleted, without deleting anything.
 *
 * `store` must already be scoped to the tenant — this module never takes
 * a businessId from a caller and never namespaces a key itself.
 */
export async function planLeadDeletion({ store, businessId, leadId }) {
  if (!businessId) throw new Error("planLeadDeletion requires a business");
  if (!leadId) return { found: false };

  const lead = await store.getLead(leadId);
  if (!lead) return { found: false };

  // Defence in depth. The scoped store already makes another tenant's key
  // unreachable, so this should be impossible; if it ever fires, something
  // upstream is wrong and refusing is the only safe answer.
  if (lead.businessId && lead.businessId !== businessId) {
    return { found: false, refusedCrossTenant: true };
  }

  const conversationId = lead.callerNumber;
  const messages = store.listMessages ? await store.listMessages(conversationId) : [];

  const owned = messages.filter((m) => m.leadId === leadId);
  const ambiguous = messages.filter((m) => m.leadId === null || m.leadId === undefined);
  const otherLeads = messages.filter((m) => m.leadId && m.leadId !== leadId);

  // Does anything else still need this conversation?
  const siblingLeads = (await store.listLeads())
    .filter((l) => l.id !== leadId && l.callerNumber === conversationId);

  const conversationRemovable =
    siblingLeads.length === 0 && ambiguous.length === 0 && otherLeads.length === 0;

  return {
    found: true,
    lead,
    conversationId,
    owned,
    preserved: [...ambiguous, ...otherLeads],
    ambiguousCount: ambiguous.length,
    otherLeadMessageCount: otherLeads.length,
    siblingLeads,
    conversationRemovable,
  };
}

/**
 * Deletes the lead and its provably-owned records.
 *
 * Ordered so that a failure part-way through leaves something coherent
 * rather than a lead pointing at records that are gone: messages first,
 * then the lead itself, then the conversation only if nothing survives.
 * A crash between steps leaves a lead with fewer messages, which the
 * dashboard renders perfectly well — the reverse order would leave
 * orphaned messages no page can reach.
 *
 * Returns a summary, and re-reads the store afterwards to confirm the
 * outcome rather than assuming the writes landed.
 */
export async function deleteLead({ store, businessId, leadId, actor = null }) {
  const plan = await planLeadDeletion({ store, businessId, leadId });
  if (!plan.found) return { deleted: false, reason: "not_found" };

  for (const message of plan.owned) {
    await store.deleteMessage(message.id, plan.conversationId, message.messageId ?? null);
  }

  await store.deleteLead(leadId);

  // Only once nothing depends on it.
  let conversationDeleted = false;
  if (plan.conversationRemovable) {
    await store.deleteConversation(plan.conversationId);
    conversationDeleted = true;
  }

  // Verify rather than assume.
  const stillThere = await store.getLead(leadId);
  const remainingMessages = store.listMessages ? await store.listMessages(plan.conversationId) : [];
  const leftBehind = remainingMessages.filter((m) => m.leadId === leadId);

  const summary = {
    deleted: !stillThere,
    leadId,
    businessId,
    messagesDeleted: plan.owned.length,
    messagesPreserved: plan.preserved.length,
    conversationDeleted,
    // Non-zero would mean a write silently failed.
    leadMessagesRemaining: leftBehind.length,
  };

  // The closest thing this project has to an audit trail: structured,
  // secret-redacting logging. No message text, no customer PII beyond the
  // ids already used throughout these logs.
  log("lead_deleted", {
    action: "DELETE_LEAD",
    businessId,
    leadId,
    actorUserId: actor?.user?.id ?? null,
    actorRole: actor?.role ?? null,
    messagesDeleted: summary.messagesDeleted,
    messagesPreserved: summary.messagesPreserved,
    conversationDeleted,
  });

  return summary;
}
