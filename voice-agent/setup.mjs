/**
 * Creates (or updates) the Vapi assistant from assistant.json, and optionally
 * places a demo call.
 *
 *   node setup.mjs                      # create/update the assistant only
 *   node setup.mjs --call +919110819125 # create/update, then ring that number
 *
 * Needs VAPI_API_KEY in .env. For --call you also need VAPI_PHONE_NUMBER_ID
 * (a number provisioned in the Vapi dashboard to dial out from).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const file = path.join(here, ".env");
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

const env = { ...loadEnv(), ...process.env };
const KEY = env.VAPI_API_KEY;
if (!KEY) {
  console.error("VAPI_API_KEY missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const api = async (route, options = {}) => {
  const res = await fetch(`https://api.vapi.ai${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...options.headers },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    console.error(`${options.method ?? "GET"} ${route} -> ${res.status}`);
    console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
};

const config = JSON.parse(fs.readFileSync(path.join(here, "assistant.json"), "utf8"));

// Idempotent: reuse the assistant with this name rather than piling up copies
// every time the prompt is tweaked (which will be often).
const existing = (await api("/assistant")).find((a) => a.name === config.name);

const assistant = existing
  ? await api(`/assistant/${existing.id}`, { method: "PATCH", body: JSON.stringify(config) })
  : await api("/assistant", { method: "POST", body: JSON.stringify(config) });

console.log(`${existing ? "updated" : "created"} assistant: ${assistant.id}`);
console.log(`  name  : ${assistant.name}`);
console.log(`  model : ${assistant.model?.model}`);
console.log(`  voice : ${assistant.voice?.provider}/${assistant.voice?.voiceId}`);

const callIndex = process.argv.indexOf("--call");
if (callIndex === -1) {
  console.log("\nNo --call given, so nothing was dialled.");
  console.log("Test it free in the Vapi dashboard first (Assistants -> Talk to Assistant).");
  process.exit(0);
}

const number = process.argv[callIndex + 1];
if (!number?.startsWith("+")) {
  console.error("--call needs an E.164 number, e.g. --call +919110819125");
  process.exit(1);
}
if (!env.VAPI_PHONE_NUMBER_ID) {
  console.error("VAPI_PHONE_NUMBER_ID missing — provision a number in the Vapi dashboard first.");
  process.exit(1);
}

// Outbound costs real money per minute. Make the target explicit in the log so
// a mistyped number is obvious before it connects, not after.
console.log(`\nDialling ${number} ...`);
const call = await api("/call", {
  method: "POST",
  body: JSON.stringify({
    assistantId: assistant.id,
    phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
    customer: { number },
  }),
});
console.log(`call id: ${call.id}  status: ${call.status}`);
console.log("Recording, transcript and extracted details appear in the Vapi dashboard when it ends.");
