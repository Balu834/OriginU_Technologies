/**
 * Centralised configuration: merges .env (if present) with process.env,
 * applies defaults, and reports which required keys are missing without
 * exiting the process itself — that decision belongs to the entrypoint,
 * not to a module tests also import.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function readEnvFile(dir = here) {
  const p = path.join(dir, ".env");
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

// Keys required for the service to actually send/receive WhatsApp messages.
export const REQUIRED_KEYS = [
  "META_ACCESS_TOKEN",
  "META_PHONE_NUMBER_ID",
  "META_VERIFY_TOKEN",
  "META_APP_SECRET",
  "MOHAMED_WHATSAPP_NUMBER",
  "MISSED_CALL_API_KEY",
  "BUSINESS_NAME",
  "OWNER_NAME",
];

export function loadConfig(env = process.env, dir = here) {
  const merged = { ...readEnvFile(dir), ...env };
  const dataDir = merged.DATA_DIR ?? path.join(dir, "data");
  return {
    META_ACCESS_TOKEN: merged.META_ACCESS_TOKEN ?? "",
    META_PHONE_NUMBER_ID: merged.META_PHONE_NUMBER_ID ?? "",
    META_WABA_ID: merged.META_WABA_ID ?? "",
    META_VERIFY_TOKEN: merged.META_VERIFY_TOKEN ?? "",
    META_APP_SECRET: merged.META_APP_SECRET ?? "",
    MOHAMED_WHATSAPP_NUMBER: merged.MOHAMED_WHATSAPP_NUMBER ?? "",
    WEBHOOK_BASE_URL: merged.WEBHOOK_BASE_URL ?? "",
    MISSED_CALL_API_KEY: merged.MISSED_CALL_API_KEY ?? "",
    WHATSAPP_MISSED_CALL_TEMPLATE: merged.WHATSAPP_MISSED_CALL_TEMPLATE ?? "missed_call_immediate",
    WHATSAPP_TEMPLATE_LANGUAGE: merged.WHATSAPP_TEMPLATE_LANGUAGE ?? "en",
    BUSINESS_NAME: merged.BUSINESS_NAME ?? "",
    OWNER_NAME: merged.OWNER_NAME ?? "",
    // "salt:hash" from `node scripts/hash-password.mjs <password>`. Optional:
    // without it the dashboard refuses to serve rather than running open.
    DASHBOARD_PASSWORD_HASH: merged.DASHBOARD_PASSWORD_HASH ?? "",
    PORT: Number(merged.PORT ?? 3000),
    DATA_DIR: dataDir,
    DEMO_MODE: merged.DEMO_MODE === "1" || merged.DEMO_MODE === "true",
  };
}

export function findMissingConfig(config) {
  return REQUIRED_KEYS.filter((k) => !config[k]);
}
