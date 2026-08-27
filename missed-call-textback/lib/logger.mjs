/**
 * Structured, secret-safe logging. Never pass tokens/secrets/headers into
 * `data` — as a defence-in-depth net, any key that looks sensitive is
 * redacted before printing, and phone numbers are masked.
 */
const SENSITIVE_KEY = /token|secret|key|authorization|signature/i;

export function maskPhone(number) {
  if (typeof number !== "string" || number.length < 6) return "***";
  return `${number.slice(0, 3)}${"*".repeat(Math.max(0, number.length - 6))}${number.slice(-3)}`;
}

function redact(data) {
  if (!data || typeof data !== "object") return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : v;
  }
  return out;
}

export function log(event, data) {
  const entry = { ts: new Date().toISOString(), event, ...redact(data) };
  console.log(JSON.stringify(entry));
}

export function logError(event, err, data) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    error: err instanceof Error ? err.message : String(err),
    ...redact(data),
  };
  console.error(JSON.stringify(entry));
}
