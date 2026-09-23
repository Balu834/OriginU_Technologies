/**
 * Verifies a business's stored WhatsApp integration against Meta, and
 * records the result.
 *
 *   node scripts/verify-integration.mjs <businessId> [--commit]
 *
 * Without --commit it only reports what Meta says and changes nothing.
 * With --commit it writes the real transition: CONNECTED with a genuine
 * lastVerifiedAt, or ERROR with the reason.
 *
 * This exists because a business's connection can stop being true without
 * anybody resubmitting a form — a token expires, a number is moved off a
 * WABA. The same verification the settings page runs has to be runnable
 * against what is already stored, and the timestamp it writes must come
 * from an actual Meta answer rather than from the fact that somebody ran
 * this script.
 *
 * Credentials are read, decrypted in memory and sent only to Meta. Nothing
 * here prints a token.
 */
import fs from "node:fs";
import path from "node:path";
import { createRedisStore } from "../lib/store.redis.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { createMetaVerifier } from "../lib/metaVerify.mjs";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    const full = path.join(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const i = trimmed.indexOf("=");
      env[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return env;
}

const businessId = process.argv[2];
const commit = process.argv.includes("--commit");

if (!businessId) {
  console.error("usage: node scripts/verify-integration.mjs <businessId> [--commit]");
  process.exit(2);
}

const env = loadEnv();
const integrations = createIntegrationService(createRedisStore(env), env);
const verifier = createMetaVerifier();

const integration = await integrations.forBusiness(businessId);
if (!integration) {
  console.error(`no integration stored for business "${businessId}"`);
  process.exit(1);
}

console.log(`business        : ${integration.businessId}`);
console.log(`phone_number_id : ${integration.phoneNumberId}`);
console.log(`waba_id         : ${integration.wabaId || "(none)"}`);
console.log(`status (before) : ${integration.status}`);
console.log(`lastVerifiedAt  : ${integration.lastVerifiedAt ?? "never"}`);
console.log(`source          : ${integration._legacy ? "env fallback (not stored)" : "stored record"}`);
console.log();

const secrets = integrations.secretsOf(integration);
const result = await verifier.verify({
  phoneNumberId: integration.phoneNumberId,
  wabaId: integration.wabaId,
  accessToken: secrets.accessToken,
});

console.log(`meta says       : ${result.ok ? "VERIFIED" : "FAILED"}`);
console.log(`reason          : ${result.reason ?? "-"}`);
console.log(`message         : ${result.message}`);
if (result.details) console.log(`details         : ${JSON.stringify(result.details)}`);
if (result.meta) console.log(`meta error      : code=${result.meta.code} subcode=${result.meta.subcode} trace=${result.meta.traceId}`);
console.log();

if (!commit) {
  console.log("dry run — nothing written. Re-run with --commit to record this result.");
  process.exit(result.ok ? 0 : 1);
}

if (integration._legacy) {
  console.log("env-backed integration is not stored, so there is nothing to record against.");
  process.exit(result.ok ? 0 : 1);
}

const updated = result.ok
  ? await integrations.markVerified(integration)
  : await integrations.markVerificationFailed(integration, result.reason);

console.log(`status (after)  : ${updated.status}`);
console.log(`lastVerifiedAt  : ${updated.lastVerifiedAt ?? "never"}`);
console.log(`lastError       : ${updated.lastError ?? "-"}`);
process.exit(result.ok ? 0 : 1);
