/**
 * Persistence, abstracted behind plain async functions so business logic
 * never touches the filesystem directly. Backed today by a single JSON
 * file — fine at one-contractor scale. Swapping to Postgres/Supabase/
 * Firebase later means reimplementing this module only; nothing in
 * routes/ or lib/conversation.mjs should need to change.
 *
 * Pass `filePath: null` for an in-memory-only store (used by tests).
 */
import fs from "node:fs";
import path from "node:path";

const EMPTY = () => ({ leads: {}, conversations: {}, processedMessages: {}, processedMissedCalls: {} });

export function createStore(filePath) {
  let data = EMPTY();

  if (filePath && fs.existsSync(filePath)) {
    try {
      data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
    } catch {
      data = EMPTY();
    }
  }

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  return {
    getConversation(callerNumber) {
      return data.conversations[callerNumber] ?? null;
    },
    saveConversation(callerNumber, state) {
      data.conversations[callerNumber] = state;
      persist();
    },

    saveLead(lead) {
      data.leads[lead.id] = lead;
      persist();
    },
    listLeads() {
      return Object.values(data.leads);
    },

    hasProcessedMessage(id) {
      return Boolean(data.processedMessages[id]);
    },
    markMessageProcessed(id) {
      data.processedMessages[id] = Date.now();
      persist();
    },

    /** Returns the timestamp (ms) the caller last triggered a missed-call template, or null. */
    lastMissedCallAt(callerNumber) {
      return data.processedMissedCalls[callerNumber] ?? null;
    },
    markMissedCall(callerNumber, atMs) {
      data.processedMissedCalls[callerNumber] = atMs;
      persist();
    },
  };
}
