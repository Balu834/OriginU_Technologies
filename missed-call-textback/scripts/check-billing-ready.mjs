/**
 * Pre-flight for the first real Razorpay checkout.
 *
 *   node scripts/check-billing-ready.mjs
 *
 * Read-only. Creates nothing, charges nothing, and never prints a secret.
 *
 * It exists because several of the ways this configuration can be wrong
 * only surface mid-payment, in front of a customer. The worst is a price
 * mismatch: checkout deliberately refuses when the Razorpay plan's amount
 * differs from PLAN_PRICING, so a plan created at the wrong figure fails
 * with a 409 at the moment someone tries to pay. Better to find that here.
 */
import fs from "node:fs";
import path from "node:path";
import { razorpayConfig, createRazorpayClient, isCheckoutConfigured, isWebhookConfigured, planIdFor, HANDLED_EVENTS } from "../lib/razorpay.mjs";
import { PLAN_PRICING, formatPrice } from "../lib/billing.mjs";

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

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failures++; };
let failures = 0;

const env = loadEnv();
const config = razorpayConfig(env);

console.log("Razorpay readiness\n");

// 1. Presence. Never prints a value — only whether one is set, and for
//    the key id, only its prefix, which tells you test vs live.
console.log("Configuration");
if (config.keyId) {
  ok(`RAZORPAY_KEY_ID set (${config.keyId.startsWith("rzp_test_") ? "TEST mode" : "LIVE mode — stop unless this is intentional"})`);
} else {
  bad("RAZORPAY_KEY_ID is not set");
}
config.keySecret ? ok("RAZORPAY_KEY_SECRET set") : bad("RAZORPAY_KEY_SECRET is not set");
isWebhookConfigured(config) ? ok("RAZORPAY_WEBHOOK_SECRET set") : bad("RAZORPAY_WEBHOOK_SECRET is not set — the webhook will refuse every event");
planIdFor(config, "PRO") ? ok("RAZORPAY_PLAN_ID_PRO set") : bad("RAZORPAY_PLAN_ID_PRO is not set");

if (!isCheckoutConfigured(config) || !planIdFor(config, "PRO")) {
  console.log("\nCannot check the plan itself until the four variables above are set.");
  process.exit(1);
}

// 2. The plan Razorpay holds must match the price this codebase displays.
console.log("\nPlan");
const client = createRazorpayClient(config);
const plan = await client.fetchPlan(planIdFor(config, "PRO"));

if (!plan.ok) {
  bad(`could not read the plan from Razorpay (HTTP ${plan.status}) — is the id right, and does it belong to these keys?`);
} else {
  const amount = plan.body?.item?.amount ?? null;
  const currency = plan.body?.item?.currency ?? null;
  const period = plan.body?.period ?? null;
  const want = PLAN_PRICING.PRO;

  amount === want.amountPaise
    ? ok(`amount ${amount} paise (${formatPrice("PRO")})`)
    : bad(`amount is ${amount} paise but this app displays ${want.amountPaise} — checkout will refuse with 409`);
  currency === want.currency ? ok(`currency ${currency}`) : bad(`currency is ${currency}, expected ${want.currency}`);
  period === "monthly" ? ok("period monthly") : bad(`period is ${period}, expected monthly`);
}

// 3. A reminder of what the dashboard still has to be told.
console.log("\nWebhook — confirm in the Razorpay dashboard");
console.log(`  URL     ${env.WEBHOOK_BASE_URL || "https://missed-call-textback-three.vercel.app"}/razorpay-webhook`);
console.log("  Secret  must equal RAZORPAY_WEBHOOK_SECRET exactly");
console.log("  Events  " + Object.keys(HANDLED_EVENTS).join("\n          "));

console.log(failures === 0
  ? "\nReady. A Test Mode purchase should now complete and activate PRO via the webhook."
  : `\n${failures} problem(s) above. Fix before attempting a payment.`);
process.exit(failures === 0 ? 0 : 1);
