/**
 * Moves a business onto a plan. Console only.
 *
 *   node scripts/set-plan.mjs <businessId> <FREE|PRO|BUSINESS> [status] --reason "..."
 *
 * This is the ONLY way a plan changes today, and it requires shell access
 * to the deployment. There is deliberately no HTTP route: until a payment
 * provider is connected there is no event that could honestly justify
 * granting a paid plan, and an endpoint that could do it would be the
 * whole vulnerability.
 *
 * When Razorpay is connected, its verified webhook becomes a second
 * caller of the same service method — not a second way to model a
 * subscription.
 */
import fs from "node:fs";
import path from "node:path";
import { createRedisStore } from "../lib/store.redis.mjs";
import { createBillingService, PLANS, SUBSCRIPTION_STATUSES } from "../lib/billing.mjs";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    const full = path.join(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return env;
}

const [businessId, plan, maybeStatus] = process.argv.slice(2);
const status = SUBSCRIPTION_STATUSES.includes(maybeStatus) ? maybeStatus : "ACTIVE";
const reasonIndex = process.argv.indexOf("--reason");
const reason = reasonIndex > -1 ? process.argv[reasonIndex + 1] : "manual console change";

if (!businessId || !PLANS.includes(plan)) {
  console.error(`usage: node scripts/set-plan.mjs <businessId> <${PLANS.join("|")}> [${SUBSCRIPTION_STATUSES.join("|")}] --reason "..."`);
  process.exit(2);
}

const billing = createBillingService(createRedisStore(loadEnv()));

const before = await billing.forBusiness(businessId);
console.log(`before : plan=${before.plan} status=${before.status}${before.implicit ? " (implicit default)" : ""}`);

const record = await billing.changePlan({ businessId, plan, status, reason });
console.log(`after  : plan=${record.plan} status=${record.status}`);
console.log(`reason : ${record.changeReason}`);

const entitlements = await billing.getBusinessEntitlements(businessId);
console.log(`limits : ${JSON.stringify(entitlements.limits)}`);
