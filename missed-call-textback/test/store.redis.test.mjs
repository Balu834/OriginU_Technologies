import test from "node:test";
import assert from "node:assert/strict";
import { createRedisStore } from "../lib/store.redis.mjs";

/** In-memory fake standing in for Upstash's REST API, enough to exercise our command shapes. */
function fakeUpstash() {
  const db = new Map();
  const sets = new Map();
  const calls = [];

  const fetchImpl = async (_url, { body }) => {
    const [cmd, ...args] = JSON.parse(body);
    calls.push([cmd, ...args]);
    let result = null;

    if (cmd === "SET") {
      const [key, value, ...opts] = args;
      db.set(key, value);
      const exIdx = opts.indexOf("EX");
      if (exIdx !== -1) db.set(`${key}:ttl`, Number(opts[exIdx + 1]));
      result = "OK";
    } else if (cmd === "GET") {
      result = db.get(args[0]) ?? null;
    } else if (cmd === "MGET") {
      result = args.map((k) => db.get(k) ?? null);
    } else if (cmd === "SADD") {
      const [key, member] = args;
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      result = 1;
    } else if (cmd === "SMEMBERS") {
      result = [...(sets.get(args[0]) ?? [])];
    }

    return { json: async () => ({ result }) };
  };

  return { fetchImpl, db, sets, calls };
}

test("conversation round-trips through GET/SET", async () => {
  const upstash = fakeUpstash();
  global.fetch = upstash.fetchImpl;
  const store = createRedisStore({ KV_REST_API_URL: "https://fake", KV_REST_API_TOKEN: "t" });

  assert.equal(await store.getConversation("+91123"), null);

  await store.saveConversation("+91123", { fields: { name: "Ravi" } });
  const loaded = await store.getConversation("+91123");
  assert.deepEqual(loaded, { fields: { name: "Ravi" } });
});

test("saveLead indexes the id so listLeads can find it via MGET", async () => {
  const upstash = fakeUpstash();
  global.fetch = upstash.fetchImpl;
  const store = createRedisStore({ KV_REST_API_URL: "https://fake", KV_REST_API_TOKEN: "t" });

  await store.saveLead({ id: "abc", name: "Ravi" });
  await store.saveLead({ id: "def", name: "Priya" });

  const leads = await store.listLeads();
  assert.equal(leads.length, 2);
  assert.deepEqual(
    leads.map((l) => l.id).sort(),
    ["abc", "def"]
  );
});

test("listLeads returns empty array without calling MGET when there are no leads", async () => {
  const upstash = fakeUpstash();
  global.fetch = upstash.fetchImpl;
  const store = createRedisStore({ KV_REST_API_URL: "https://fake", KV_REST_API_TOKEN: "t" });

  assert.deepEqual(await store.listLeads(), []);
  assert.ok(!upstash.calls.some(([cmd]) => cmd === "MGET"));
});

test("markMessageProcessed sets an expiring key; hasProcessedMessage reads it back", async () => {
  const upstash = fakeUpstash();
  global.fetch = upstash.fetchImpl;
  const store = createRedisStore({ KV_REST_API_URL: "https://fake", KV_REST_API_TOKEN: "t" });

  assert.equal(await store.hasProcessedMessage("wamid.1"), false);
  await store.markMessageProcessed("wamid.1");
  assert.equal(await store.hasProcessedMessage("wamid.1"), true);

  const setCall = upstash.calls.find(([cmd, key]) => cmd === "SET" && key === "processed:message:wamid.1");
  assert.ok(setCall.includes("EX"), "should set an expiry so processed ids don't accumulate forever");
});

test("markMissedCall / lastMissedCallAt round-trip a numeric timestamp with an expiry", async () => {
  const upstash = fakeUpstash();
  global.fetch = upstash.fetchImpl;
  const store = createRedisStore({ KV_REST_API_URL: "https://fake", KV_REST_API_TOKEN: "t" });

  assert.equal(await store.lastMissedCallAt("+91999"), null);
  await store.markMissedCall("+91999", 12345);
  assert.equal(await store.lastMissedCallAt("+91999"), 12345);

  const setCall = upstash.calls.find(([cmd, key]) => cmd === "SET" && key === "missedcall:+91999");
  assert.ok(setCall.includes("EX"));
});

test("throws a clear error when Upstash env vars are missing", () => {
  assert.throws(() => createRedisStore({}), /KV_REST_API_URL/);
});
