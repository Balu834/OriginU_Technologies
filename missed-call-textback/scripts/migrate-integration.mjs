/**
 * Converts the global META_* configuration into a stored, encrypted
 * integration for one business.
 *
 *   node scripts/migrate-integration.mjs            # dry run
 *   node scripts/migrate-integration.mjs --apply    # write it
 *
 * Reads credentials from the environment and writes them encrypted.
 * Nothing secret is printed: output shows only masked identifiers and
 * whether each credential was present. The env variables are left in
 * place — the migration-only fallback keeps the live business working
 * until the stored integration is verified in production.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";
import { createRedisStore } from "../lib/store.redis.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { publicView } from "../lib/integrations.mjs";
import { isValidEncryptionKey, generateEncryptionKey, maskIdentifier } from "../lib/crypto.mjs";

const apply = process.argv.includes("--apply");
const businessId = process.argv.find((a) => a.startsWith("--business="))?.split("=")[1] ?? "default";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(process.env, projectRoot);

if (!isValidEncryptionKey(config.INTEGRATION_ENCRYPTION_KEY)) {
  console.error("INTEGRATION_ENCRYPTION_KEY is missing or not 64 hex characters.");
  console.error("Generate one and set it in .env and on Vercel:\n");
  console.error(`  INTEGRATION_ENCRYPTION_KEY=${generateEncryptionKey()}\n`);
  process.exit(1);
}

const present = (v) => (v ? "present" : "MISSING");
console.log(`business          : ${businessId}`);
console.log(`phoneNumberId     : ${maskIdentifier(config.META_PHONE_NUMBER_ID)}`);
console.log(`wabaId            : ${maskIdentifier(config.META_WABA_ID)}`);
console.log(`accessToken       : ${present(config.META_ACCESS_TOKEN)}`);
console.log(`appSecret         : ${present(config.META_APP_SECRET)}`);
console.log(`verifyToken       : ${present(config.META_VERIFY_TOKEN)}`);

if (!config.META_PHONE_NUMBER_ID || !config.META_ACCESS_TOKEN) {
  console.error("\nRefusing to migrate: phone number id and access token are both required.");
  process.exit(1);
}

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write the encrypted integration.");
  process.exit(0);
}

const store = createRedisStore(process.env);
const integrations = createIntegrationService(store, config);

const existing = await store.getIntegrationByBusiness(businessId);
if (existing) {
  console.log("\nAn integration already exists for this business:");
  console.log(publicView(existing));
  console.log("Nothing written.");
  process.exit(0);
}

const integration = await integrations.register({
  businessId,
  phoneNumberId: config.META_PHONE_NUMBER_ID,
  wabaId: config.META_WABA_ID,
  accessToken: config.META_ACCESS_TOKEN,
  appSecret: config.META_APP_SECRET,
  verifyToken: config.META_VERIFY_TOKEN,
  status: "CONFIGURED",
});

console.log("\nWritten. Stored integration (safe view):");
console.log(publicView(integration));
console.log("\nThe global META_* variables are still in place and still work.");
console.log("Remove them only after verifying the stored integration in production.");
