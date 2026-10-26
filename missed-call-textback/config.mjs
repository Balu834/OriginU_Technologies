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
    // --- Embedded Signup (customer-facing "Connect WhatsApp") ---
    // Both are public identifiers: the app id is sent to the browser by
    // design, and the configuration id names which Facebook Login for
    // Business configuration the popup should run. Without both, the
    // settings page says so and offers Advanced Setup rather than
    // rendering a button that cannot work.
    META_APP_ID: merged.META_APP_ID ?? "",
    META_EMBEDDED_SIGNUP_CONFIG_ID: merged.META_EMBEDDED_SIGNUP_CONFIG_ID ?? "",
    // Graph version for the signup flow only; the send and verify paths
    // keep their own pinned version.
    META_GRAPH_VERSION: merged.META_GRAPH_VERSION ?? "",
    // Two-step PIN used when registering a newly connected number for
    // Cloud API. Unset means registration is skipped rather than a PIN
    // being invented that nobody could reproduce later.
    WHATSAPP_REGISTER_PIN: merged.WHATSAPP_REGISTER_PIN ?? "",
    MOHAMED_WHATSAPP_NUMBER: merged.MOHAMED_WHATSAPP_NUMBER ?? "",
    WEBHOOK_BASE_URL: merged.WEBHOOK_BASE_URL ?? "",
    // Password-reset email via Resend's REST API. Both keys plus a public
    // base URL are needed, or the forgot-password page says email reset is
    // unavailable instead of pretending to send. The link host comes from
    // config, never from the request's Host header.
    RESEND_API_KEY: merged.RESEND_API_KEY ?? "",
    RESET_EMAIL_FROM: merged.RESET_EMAIL_FROM ?? "",
    PUBLIC_BASE_URL: merged.PUBLIC_BASE_URL ?? "",
    // "Continue with Google" on the sign-in and sign-up pages. Both come
    // from a Google Cloud OAuth client (Web application) whose authorised
    // redirect URI is <PUBLIC_BASE_URL>/auth/google/callback. Without both
    // (and a public base URL) the button is simply not shown.
    GOOGLE_CLIENT_ID: merged.GOOGLE_CLIENT_ID ?? "",
    GOOGLE_CLIENT_SECRET: merged.GOOGLE_CLIENT_SECRET ?? "",
    MISSED_CALL_API_KEY: merged.MISSED_CALL_API_KEY ?? "",
    WHATSAPP_MISSED_CALL_TEMPLATE: merged.WHATSAPP_MISSED_CALL_TEMPLATE ?? "missed_call_immediate",
    WHATSAPP_TEMPLATE_LANGUAGE: merged.WHATSAPP_TEMPLATE_LANGUAGE ?? "en",
    BUSINESS_NAME: merged.BUSINESS_NAME ?? "",
    OWNER_NAME: merged.OWNER_NAME ?? "",
    // "salt:hash" from `node scripts/hash-password.mjs <password>`. Optional:
    // without it the dashboard refuses to serve rather than running open.
    DASHBOARD_PASSWORD_HASH: merged.DASHBOARD_PASSWORD_HASH ?? "",
    // Encrypts per-business integration credentials at rest. Stays in the
    // environment: a key stored beside its ciphertext protects nothing.
    INTEGRATION_ENCRYPTION_KEY: merged.INTEGRATION_ENCRYPTION_KEY ?? "",
    // MIGRATION-ONLY: the single business allowed to fall back to the
    // global META_* variables. TODO(remove) once its integration is stored.
    MIGRATION_DEFAULT_BUSINESS_ID: merged.MIGRATION_DEFAULT_BUSINESS_ID ?? "default",
    // --- QR-code WhatsApp connection (UNOFFICIAL, see qr-gateway/README.md) ---
    // The flag only controls whether the settings page OFFERS it. Businesses
    // already connected this way keep working while the gateway URL and
    // secret are set, so switching the flag off can't strand them mid-chat.
    QR_CONNECT_ENABLED: merged.QR_CONNECT_ENABLED === "1" || merged.QR_CONNECT_ENABLED === "true",
    // The always-on gateway (Fly.io), e.g. https://missedcall-qr-gateway.fly.dev
    QR_GATEWAY_URL: merged.QR_GATEWAY_URL ?? "",
    // Shared HMAC secret, at least 32 characters, same value on the gateway.
    QR_GATEWAY_SECRET: merged.QR_GATEWAY_SECRET ?? "",
    PORT: Number(merged.PORT ?? 3000),
    DATA_DIR: dataDir,
    DEMO_MODE: merged.DEMO_MODE === "1" || merged.DEMO_MODE === "true",
  };
}

export function findMissingConfig(config) {
  return REQUIRED_KEYS.filter((k) => !config[k]);
}
