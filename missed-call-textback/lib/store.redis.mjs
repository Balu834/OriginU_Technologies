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

    async saveLead(lead) {
      await command("SET", `lead:${lead.id}`, JSON.stringify(lead));
      await command("SADD", "leads:index", lead.id);
    },
    async listLeads() {
      const ids = (await command("SMEMBERS", "leads:index")) ?? [];
      if (!ids.length) return [];
      const raws = await command("MGET", ...ids.map((id) => `lead:${id}`));
      return raws.filter(Boolean).map((r) => JSON.parse(r));
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
  };
}
