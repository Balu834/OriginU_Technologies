/**
 * Upstash Redis over its REST API: the same database the app uses, with
 * no client library.
 *
 * `pipeline` sends many commands in one HTTP request. WhatsApp's Signal
 * keys change on most messages, and one request per key would be slow and
 * would run up Upstash's per-request cost for nothing.
 */
export function createRedis({ url, token, fetchImpl = fetch }) {
  if (!url || !token) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are required");
  const base = url.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function post(path, payload) {
    const res = await fetchImpl(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => null);
    if (!res.ok && !body) throw new Error(`Redis HTTP ${res.status}`);
    return body;
  }

  return {
    async command(...parts) {
      const body = await post("", parts.map(String));
      if (body?.error) throw new Error(`Redis command failed: ${body.error}`);
      return body?.result ?? null;
    },

    /** Runs commands in order in one request. Returns each result; throws on the first error. */
    async pipeline(commands) {
      if (!commands.length) return [];
      const body = await post("/pipeline", commands.map((c) => c.map(String)));
      if (!Array.isArray(body)) throw new Error("Redis pipeline failed");
      return body.map((r) => {
        if (r?.error) throw new Error(`Redis command failed: ${r.error}`);
        return r?.result ?? null;
      });
    },
  };
}

/**
 * An in-memory stand-in with the same two methods, for tests and for
 * running the gateway locally without Upstash. Supports only the commands
 * the gateway uses.
 */
export function createMemoryRedis() {
  const strings = new Map();
  const sets = new Map();
  const expires = new Map();

  const alive = (k) => {
    const at = expires.get(k);
    if (at !== undefined && at <= Date.now()) {
      strings.delete(k);
      sets.delete(k);
      expires.delete(k);
    }
    return strings.has(k) || sets.has(k);
  };

  function run([cmd, ...args]) {
    switch (String(cmd).toUpperCase()) {
      case "GET": return alive(args[0]) ? strings.get(args[0]) ?? null : null;
      case "MGET": return args.map((k) => (alive(k) ? strings.get(k) ?? null : null));
      case "SET": {
        const [k, v, ...opts] = args;
        const upper = opts.map((o) => String(o).toUpperCase());
        if (upper.includes("NX") && alive(k)) return null;
        if (upper.includes("XX") && !alive(k)) return null;
        strings.set(k, String(v));
        const ex = upper.indexOf("EX");
        if (ex >= 0) expires.set(k, Date.now() + Number(opts[ex + 1]) * 1000);
        else expires.delete(k);
        return "OK";
      }
      case "DEL": {
        let n = 0;
        for (const k of args) {
          if (alive(k)) n++;
          strings.delete(k); sets.delete(k); expires.delete(k);
        }
        return n;
      }
      case "EXPIRE":
        if (!alive(args[0])) return 0;
        expires.set(args[0], Date.now() + Number(args[1]) * 1000);
        return 1;
      case "SADD": {
        const s = alive(args[0]) ? sets.get(args[0]) ?? new Set() : new Set();
        let n = 0;
        for (const m of args.slice(1)) if (!s.has(m)) { s.add(String(m)); n++; }
        sets.set(args[0], s);
        return n;
      }
      case "SREM": {
        const s = alive(args[0]) ? sets.get(args[0]) : null;
        let n = 0;
        for (const m of args.slice(1)) if (s?.delete(String(m))) n++;
        return n;
      }
      case "SMEMBERS": return alive(args[0]) ? [...(sets.get(args[0]) ?? [])] : [];
      default: throw new Error(`memory redis: unsupported command ${cmd}`);
    }
  }

  return {
    strings,
    sets,
    async command(...parts) { return run(parts.map(String)); },
    async pipeline(commands) { return commands.map((c) => run(c.map(String))); },
  };
}
