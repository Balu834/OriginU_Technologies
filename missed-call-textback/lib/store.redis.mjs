/**
 * Same async interface as ./store.mjs, backed by Upstash Redis over its
 * REST API instead of a local JSON file — the persistence layer needed on
 * Vercel, where there is no writable, shared disk between invocations.
 * Route/conversation code never imports this directly; server.mjs and the
 * api/ handlers pick whichever store fits the environment.
 *
 * Provisioned via `vercel install upstash`, which sets KV_REST_API_URL /
 * KV_REST_API_TOKEN in the project's environment automatically.
 *
 * Design notes:
 * - Idempotency keys (`processed:message:*`, `missedcall:*`) use Redis TTL
 *   via `SET ... EX <seconds> NX` — an atomic "set if absent, expire
 *   automatically" that the JSON-file store can only approximate with a
 *   manual timestamp check, and which self-prunes instead of growing
 *   forever.
 * - `listLeads` keeps a Redis SET of lead ids (`leads:index`) since Redis
 *   has no native "list all keys matching a pattern" that's safe/cheap at
 *   scale.
 */
const MISSED_CALL_TTL_SECONDS = 10 * 60; // matches routes/missedCall.mjs's dedupe window
const PROCESSED_MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days is far beyond any realistic Meta retry window
const USAGE_TTL_SECONDS = 400 * 24 * 60 * 60; // comfortably longer than any billing period we report on

/**
 * Scopes a store to one business. Tenant isolation is structural: the
 * business id is baked into every key, so there is no code path that can
 * read another tenant's data by forgetting a filter. Callers get a scoped
 * store or nothing.
 */
export function scopedToBusiness(store, businessId) {
  if (!businessId) throw new Error("scopedToBusiness requires a business id");
  const ns = `b:${businessId}:`;
  return {
    getConversation: (n) => store.getConversation(ns + n),
    saveConversation: (n, s) => store.saveConversation(ns + n, s),
    getLead: (id) => store.getLead(ns + id),
    saveLead: (lead) => store.saveLead({ ...lead, businessId, id: lead.id }, ns),
    listLeads: () => store.listLeads(ns),
    hasProcessedMessage: (id) => store.hasProcessedMessage(ns + id),
    markMessageProcessed: (id) => store.markMessageProcessed(ns + id),
    saveMessage: (m) => store.saveMessage({ ...m, businessId }, ns),
    listMessages: (cid) => store.listMessages(cid, ns),
    findMessageByProviderId: (pid) => store.findMessageByProviderId(pid, ns),
    updateMessage: (m) => store.updateMessage(m, ns),
    deleteLead: (id) => store.deleteLead(id, ns),
    deleteMessage: (id, cid, pid) => store.deleteMessage(id, cid, pid, ns),
    deleteConversation: (cid) => store.deleteConversation(cid, ns),
    lastMissedCallAt: (n) => store.lastMissedCallAt(ns + n),
    markMissedCall: (n, at) => store.markMissedCall(ns + n, at),
    // Sessions and rate limits are deployment-wide, not per-tenant.
    // Business records are deployment-wide, exposed unscoped.
    saveUser: store.saveUser?.bind(store),
    getUser: store.getUser?.bind(store),
    getUserByEmail: store.getUserByEmail?.bind(store),
    saveMembership: store.saveMembership?.bind(store),
    deleteMembership: store.deleteMembership?.bind(store),
    listMembershipsByUser: store.listMembershipsByUser?.bind(store),
    listMembershipsByBusiness: store.listMembershipsByBusiness?.bind(store),
    saveIntegration: store.saveIntegration?.bind(store),
    getIntegration: store.getIntegration?.bind(store),
    getIntegrationByBusiness: store.getIntegrationByBusiness?.bind(store),
    getIntegrationByPhoneNumberId: store.getIntegrationByPhoneNumberId?.bind(store),
    releasePhoneNumberMapping: store.releasePhoneNumberMapping?.bind(store),
    saveSubscription: store.saveSubscription?.bind(store),
    getSubscription: store.getSubscription?.bind(store),
    incrementUsage: store.incrementUsage?.bind(store),
    getUsage: store.getUsage?.bind(store),
    saveProviderSubscription: store.saveProviderSubscription?.bind(store),
    getBusinessByProviderSubscription: store.getBusinessByProviderSubscription?.bind(store),
    claimOnce: store.claimOnce?.bind(store),
    releaseClaim: store.releaseClaim?.bind(store),
    saveBusiness: store.saveBusiness,
    getBusiness: store.getBusiness,
    listBusinesses: store.listBusinesses,
    saveSession: store.saveSession,
    getSession: store.getSession,
    deleteSession: store.deleteSession,
    bumpRateLimit: store.bumpRateLimit,
  };
}

export function createRedisStore(env = process.env) {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("createRedisStore requires KV_REST_API_URL and KV_REST_API_TOKEN (run `vercel install upstash`)");
  }

  async function command(...parts) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(parts),
    });
    const body = await res.json();
    if (body.error) throw new Error(`Redis command failed: ${body.error}`);
    return body.result;
  }

  return {
    async getConversation(callerNumber) {
      const raw = await command("GET", `conversation:${callerNumber}`);
      return raw ? JSON.parse(raw) : null;
    },
    async saveConversation(callerNumber, state) {
      await command("SET", `conversation:${callerNumber}`, JSON.stringify(state));
    },

    // `ns` is the tenant prefix supplied by scopedToBusiness; the index key
    // is namespaced too, so one business's index can never enumerate
    // another's leads.
    async saveLead(lead, ns = "") {
      await command("SET", `lead:${ns}${lead.id}`, JSON.stringify(lead));
      await command("SADD", `${ns}leads:index`, lead.id);
    },
    async getLead(id) {
      const raw = await command("GET", `lead:${id}`);
      return raw ? JSON.parse(raw) : null;
    },
    async listLeads(ns = "") {
      const ids = (await command("SMEMBERS", `${ns}leads:index`)) ?? [];
      if (!ids.length) return [];
      const raws = await command("MGET", ...ids.map((id) => `lead:${ns}${id}`));
      return raws.filter(Boolean).map((r) => JSON.parse(r));
    },

    /**
     * Removes one lead and its index entry. The index is updated first:
     * an id in the index with no record behind it renders as a missing
     * row, whereas a record with no index entry is invisible but still
     * occupying its key.
     */
    async deleteLead(id, ns = "") {
      await command("SREM", `${ns}leads:index`, id);
      await command("DEL", `lead:${ns}${id}`);
    },

    /**
     * Removes one message: the record, its position in the conversation's
     * list, and the wamid lookup that points at it. `LREM ... 0` removes
     * every occurrence, so a list that somehow gained a duplicate entry is
     * cleaned rather than half-cleaned.
     */
    async deleteMessage(messageId, conversationId, providerMessageId = null, ns = "") {
      await command("LREM", `${ns}messages:${conversationId}`, "0", messageId);
      await command("DEL", `msg:${ns}${messageId}`);
      if (providerMessageId) await command("DEL", `${ns}msgid:${providerMessageId}`);
    },

    /** Removes a conversation's state and its (by now empty) message list. */
    async deleteConversation(conversationId, ns = "") {
      await command("DEL", `conversation:${ns}${conversationId}`);
      await command("DEL", `${ns}messages:${conversationId}`);
    },

    /**
     * Transcript storage. Messages live in a per-conversation list so
     * ordering is insertion order — the order they actually happened —
     * rather than something reconstructed from timestamps that may tie.
     * `msgid:` is a lookup index from Meta's wamid back to our record, so
     * a later status webhook can find the message it refers to.
     */
    async saveMessage(message, ns = "") {
      await command("SET", `msg:${ns}${message.id}`, JSON.stringify(message));
      await command("RPUSH", `${ns}messages:${message.conversationId}`, message.id);
      if (message.messageId) {
        await command("SET", `${ns}msgid:${message.messageId}`, message.id);
      }
    },
    async listMessages(conversationId, ns = "") {
      const ids = (await command("LRANGE", `${ns}messages:${conversationId}`, "0", "-1")) ?? [];
      if (!ids.length) return [];
      const raws = await command("MGET", ...ids.map((id) => `msg:${ns}${id}`));
      return raws.filter(Boolean).map((r) => JSON.parse(r));
    },
    async findMessageByProviderId(providerMessageId, ns = "") {
      const ourId = await command("GET", `${ns}msgid:${providerMessageId}`);
      if (!ourId) return null;
      const raw = await command("GET", `msg:${ns}${ourId}`);
      return raw ? JSON.parse(raw) : null;
    },
    async updateMessage(message, ns = "") {
      await command("SET", `msg:${ns}${message.id}`, JSON.stringify(message));
    },

    // Businesses are deployment-wide, not tenant-scoped — a tenant must
    // never be able to enumerate or edit another tenant's record.
    async saveBusiness(business) {
      await command('SET', 'business:' + business.id, JSON.stringify(business));
      await command('SADD', 'businesses:index', business.id);
    },
    async getBusiness(id) {
      const raw = await command('GET', 'business:' + id);
      return raw ? JSON.parse(raw) : null;
    },
    async listBusinesses() {
      const ids = (await command('SMEMBERS', 'businesses:index')) ?? [];
      if (!ids.length) return [];
      const raws = await command('MGET', ...ids.map((id) => 'business:' + id));
      return raws.filter(Boolean).map((x) => JSON.parse(x));
    },

    // Integrations are deployment-wide records keyed two ways: by business
    // (what to send with) and by phone number id (who an inbound message
    // belongs to). The phone-number index is what makes routing a lookup
    // rather than a scan.
    async saveIntegration(integration) {
      await command('SET', 'integration:' + integration.id, JSON.stringify(integration));
      await command('SET', 'integration:business:' + integration.businessId, integration.id);
      await command('SET', 'integration:phone:' + integration.phoneNumberId, integration.id);
      await command('SADD', 'integrations:index', integration.id);
    },

    /**
     * Drops a phone-number mapping, but only if it still points at the
     * integration that is giving it up.
     *
     * The compare-and-delete is the whole point: an unconditional delete
     * of `integration:phone:<n>` would let one business release a number
     * that now belongs to another. Done as a Lua script so the check and
     * the delete are one atomic step — a read-then-delete could still
     * remove a mapping that changed owner in between.
     */
    async releasePhoneNumberMapping(phoneNumberId, integrationId) {
      if (!phoneNumberId || !integrationId) return false;
      const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      const deleted = await command('EVAL', script, '1', 'integration:phone:' + phoneNumberId, integrationId);
      return Number(deleted) === 1;
    },
    async getIntegration(id) {
      const raw = await command('GET', 'integration:' + id);
      return raw ? JSON.parse(raw) : null;
    },
    async getIntegrationByBusiness(businessId) {
      const id = await command('GET', 'integration:business:' + businessId);
      return id ? this.getIntegration(id) : null;
    },
    async getIntegrationByPhoneNumberId(phoneNumberId) {
      const id = await command('GET', 'integration:phone:' + phoneNumberId);
      return id ? this.getIntegration(id) : null;
    },

    // Users and memberships are deployment-wide. The email index is what
    // makes login a lookup instead of a scan, and is lowercased by the
    // caller so two casings can't become two accounts.
    async saveUser(user) {
      await command('SET', 'user:' + user.id, JSON.stringify(user));
      await command('SET', 'user:email:' + user.email, user.id);
    },
    async getUser(id) {
      const raw = await command('GET', 'user:' + id);
      return raw ? JSON.parse(raw) : null;
    },
    async getUserByEmail(email) {
      const id = await command('GET', 'user:email:' + email);
      return id ? this.getUser(id) : null;
    },
    async saveMembership(m) {
      await command('SET', 'membership:' + m.id, JSON.stringify(m));
      await command('SADD', 'memberships:user:' + m.userId, m.id);
      await command('SADD', 'memberships:business:' + m.businessId, m.id);
    },
    async deleteMembership(id) {
      const raw = await command('GET', 'membership:' + id);
      if (!raw) return;
      const m = JSON.parse(raw);
      await command('SREM', 'memberships:user:' + m.userId, id);
      await command('SREM', 'memberships:business:' + m.businessId, id);
      await command('DEL', 'membership:' + id);
    },
    async listMembershipsByUser(userId) {
      const ids = (await command('SMEMBERS', 'memberships:user:' + userId)) ?? [];
      if (!ids.length) return [];
      const raws = await command('MGET', ...ids.map((i) => 'membership:' + i));
      return raws.filter(Boolean).map((x) => JSON.parse(x));
    },
    async listMembershipsByBusiness(businessId) {
      const ids = (await command('SMEMBERS', 'memberships:business:' + businessId)) ?? [];
      if (!ids.length) return [];
      const raws = await command('MGET', ...ids.map((i) => 'membership:' + i));
      return raws.filter(Boolean).map((x) => JSON.parse(x));
    },

    // Subscriptions and usage are deployment-wide records keyed BY business
    // id, like integrations — a tenant must never be able to enumerate or
    // edit another tenant's plan.
    async saveSubscription(subscription) {
      await command('SET', 'subscription:' + subscription.businessId, JSON.stringify(subscription));
      await command('SADD', 'subscriptions:index', subscription.businessId);
    },
    async getSubscription(businessId) {
      const raw = await command('GET', 'subscription:' + businessId);
      return raw ? JSON.parse(raw) : null;
    },

    /**
     * The authoritative provider -> tenant index.
     *
     * Webhook tenant identity is resolved through this and nothing else.
     * Razorpay's `notes` can carry a business id for humans reading the
     * dashboard, but notes travel with the payload and are not proof of
     * anything; this mapping was written by us, server-side, at the
     * moment we created the subscription.
     */
    async saveProviderSubscription(providerSubscriptionId, businessId) {
      await command('SET', 'provider:razorpay:sub:' + providerSubscriptionId, businessId);
    },
    async getBusinessByProviderSubscription(providerSubscriptionId) {
      if (!providerSubscriptionId) return null;
      return (await command('GET', 'provider:razorpay:sub:' + providerSubscriptionId)) ?? null;
    },

    /**
     * Claims a one-shot key, atomically. Returns true for the caller that
     * won, false for every later (or concurrent) caller.
     *
     * SET NX is a single round trip that both tests and sets, so two
     * simultaneous deliveries of the same webhook cannot both see "not
     * processed yet" and both apply it — which a GET-then-SET would allow.
     */
    async claimOnce(key, ttlSeconds) {
      const result = await command('SET', key, '1', 'EX', String(ttlSeconds), 'NX');
      return result === 'OK';
    },

    /**
     * Gives a claim back, for when the work after it failed.
     *
     * Without this, an event whose processing threw would stay claimed
     * and every retry would be discarded as a duplicate — the failure
     * would become permanent precisely because we were careful about
     * duplicates.
     */
    async releaseClaim(key) {
      await command('DEL', key);
    },

    /**
     * INCR is atomic, so two concurrent lambdas cannot lose a count the
     * way a GET-then-SET would. The TTL is set only on first write, so a
     * counter's lifetime does not slide forward with every increment.
     */
    async incrementUsage(key, by = 1) {
      const total = await command('INCRBY', key, String(by));
      if (Number(total) === Number(by)) {
        await command('EXPIRE', key, String(USAGE_TTL_SECONDS));
      }
      return Number(total);
    },
    async getUsage(key) {
      const raw = await command('GET', key);
      return raw ? Number(raw) : 0;
    },

    async hasProcessedMessage(id) {
      return Boolean(await command("GET", `processed:message:${id}`));
    },
    async markMessageProcessed(id) {
      await command("SET", `processed:message:${id}`, "1", "EX", String(PROCESSED_MESSAGE_TTL_SECONDS));
    },

    /** Returns the timestamp (ms) the caller last triggered a missed-call template, or null. */
    async lastMissedCallAt(callerNumber) {
      const raw = await command("GET", `missedcall:${callerNumber}`);
      return raw ? Number(raw) : null;
    },
    async markMissedCall(callerNumber, atMs) {
      await command("SET", `missedcall:${callerNumber}`, String(atMs), "EX", String(MISSED_CALL_TTL_SECONDS));
    },

    async saveSession(id, session, ttlSeconds) {
      await command("SET", `session:${id}`, JSON.stringify(session), "EX", String(ttlSeconds));
    },
    async getSession(id) {
      const raw = await command("GET", `session:${id}`);
      return raw ? JSON.parse(raw) : null;
    },
    async deleteSession(id) {
      await command("DEL", `session:${id}`);
    },

    /** Increments a windowed counter and returns the new count — used to throttle login attempts. */
    async bumpRateLimit(key, windowSeconds) {
      const count = await command("INCR", `ratelimit:${key}`);
      // Only set the expiry on first increment, so the window doesn't slide
      // forward with every attempt and let an attacker keep it alive forever.
      if (count === 1) await command("EXPIRE", `ratelimit:${key}`, String(windowSeconds));
      return count;
    },
  };
}
