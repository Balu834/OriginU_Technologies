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

export { scopedToBusiness } from "./store.redis.mjs";

const EMPTY = () => ({
  leads: {},
  conversations: {},
  processedMessages: {},
  processedMissedCalls: {},
  sessions: {},
  rateLimits: {},
  messages: {},
  messageIndex: {},
  providerIndex: {},
  businesses: {},
  integrations: {},
  integrationByBusiness: {},
  integrationByPhone: {},
  users: {},
  userByEmail: {},
  memberships: {},
});

/** Entries with a TTL are stored as { value, expiresAt } — Redis does this natively, the file store has to check by hand. */
function readExpiring(bucket, key) {
  const entry = bucket[key];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete bucket[key];
    return null;
  }
  return entry;
}

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
    async getConversation(callerNumber) {
      return data.conversations[callerNumber] ?? null;
    },
    async saveConversation(callerNumber, state) {
      data.conversations[callerNumber] = state;
      persist();
    },

    // `ns` is the tenant prefix supplied by scopedToBusiness — see
    // lib/store.redis.mjs. Both backends namespace identically so tests
    // against the in-memory store prove the same isolation as production.
    async saveLead(lead, ns = "") {
      data.leads[`${ns}${lead.id}`] = lead;
      persist();
    },
    async getLead(id) {
      return data.leads[id] ?? null;
    },
    async listLeads(ns = "") {
      return Object.entries(data.leads)
        .filter(([key]) => key.startsWith(ns) && (ns || !key.startsWith("b:")))
        .map(([, lead]) => lead);
    },

    // Transcript storage — mirrors lib/store.redis.mjs exactly, so tests
    // against this backend prove the same behaviour as production.
    async saveMessage(message, ns = "") {
      data.messages[`${ns}${message.id}`] = message;
      const listKey = `${ns}${message.conversationId}`;
      (data.messageIndex[listKey] ??= []).push(message.id);
      if (message.messageId) data.providerIndex[`${ns}${message.messageId}`] = message.id;
      persist();
    },
    async listMessages(conversationId, ns = "") {
      const ids = data.messageIndex[`${ns}${conversationId}`] ?? [];
      return ids.map((id) => data.messages[`${ns}${id}`]).filter(Boolean);
    },
    async findMessageByProviderId(providerMessageId, ns = "") {
      const ourId = data.providerIndex[`${ns}${providerMessageId}`];
      return ourId ? (data.messages[`${ns}${ourId}`] ?? null) : null;
    },
    async updateMessage(message, ns = "") {
      data.messages[`${ns}${message.id}`] = message;
      persist();
    },

    async saveBusiness(business) {
      data.businesses[business.id] = business;
      persist();
    },
    async getBusiness(id) {
      return data.businesses[id] ?? null;
    },
    async listBusinesses() {
      return Object.values(data.businesses);
    },

    async saveIntegration(integration) {
      data.integrations[integration.id] = integration;
      data.integrationByBusiness[integration.businessId] = integration.id;
      data.integrationByPhone[integration.phoneNumberId] = integration.id;
      persist();
    },
    async getIntegration(id) {
      return data.integrations[id] ?? null;
    },
    async getIntegrationByBusiness(businessId) {
      const id = data.integrationByBusiness[businessId];
      return id ? (data.integrations[id] ?? null) : null;
    },
    async getIntegrationByPhoneNumberId(phoneNumberId) {
      const id = data.integrationByPhone[phoneNumberId];
      return id ? (data.integrations[id] ?? null) : null;
    },

    async saveUser(user) {
      data.users[user.id] = user;
      data.userByEmail[user.email] = user.id;
      persist();
    },
    async getUser(id) { return data.users[id] ?? null; },
    async getUserByEmail(email) {
      const id = data.userByEmail[email];
      return id ? (data.users[id] ?? null) : null;
    },
    async saveMembership(m) {
      data.memberships[m.id] = m;
      persist();
    },
    async deleteMembership(id) {
      delete data.memberships[id];
      persist();
    },
    async listMembershipsByUser(userId) {
      return Object.values(data.memberships).filter((m) => m.userId === userId);
    },
    async listMembershipsByBusiness(businessId) {
      return Object.values(data.memberships).filter((m) => m.businessId === businessId);
    },

    async hasProcessedMessage(id) {
      return Boolean(data.processedMessages[id]);
    },
    async markMessageProcessed(id) {
      data.processedMessages[id] = Date.now();
      persist();
    },

    /** Returns the timestamp (ms) the caller last triggered a missed-call template, or null. */
    async lastMissedCallAt(callerNumber) {
      return data.processedMissedCalls[callerNumber] ?? null;
    },
    async markMissedCall(callerNumber, atMs) {
      data.processedMissedCalls[callerNumber] = atMs;
      persist();
    },

    async saveSession(id, session, ttlSeconds) {
      data.sessions[id] = { value: session, expiresAt: Date.now() + ttlSeconds * 1000 };
      persist();
    },
    async getSession(id) {
      return readExpiring(data.sessions, id)?.value ?? null;
    },
    async deleteSession(id) {
      delete data.sessions[id];
      persist();
    },

    /** Increments a windowed counter and returns the new count — used to throttle login attempts. */
    async bumpRateLimit(key, windowSeconds) {
      const existing = readExpiring(data.rateLimits, key);
      const count = (existing?.value ?? 0) + 1;
      data.rateLimits[key] = {
        value: count,
        expiresAt: existing?.expiresAt ?? Date.now() + windowSeconds * 1000,
      };
      persist();
      return count;
    },
  };
}
