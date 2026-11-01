/**
 * What each marketer earned in a month. Console only, read-only.
 *
 *   node scripts/referral-report.mjs                      this month, one line per code
 *   node scripts/referral-report.mjs --month 2026-11      a given month
 *   node scripts/referral-report.mjs --detail             plus each business and where it stands
 *   node scripts/referral-report.mjs --code ravi --detail
 *
 * Reads the same Upstash database as the app (KV_REST_API_URL and
 * KV_REST_API_TOKEN from the environment, .env or .env.local).
 *
 * The rules (REFERRAL_RULES in lib/referrals.mjs):
 *   Rs 100 per VERIFIED connect: WhatsApp connected, then a first real lead
 *          within 14 days. Counted in the month it was verified.
 *   Rs 200 once when a referred business starts paying, in that month.
 *   Monthly bonus on verified connects: 50 -> Rs 1,000, 150 -> Rs 2,500,
 *          300 -> Rs 5,000 (highest step reached only).
 */
import fs from "node:fs";
import path from "node:path";
import { createRedisStore, scopedToBusiness } from "../lib/store.redis.mjs";
import { monthlyPayouts, monthOf, normalizeRefCode, REFERRAL_RULES } from "../lib/referrals.mjs";

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

/** One row per referred business, read from the store. */
export async function referralRows(store) {
  const rows = [];
  for (const b of (await store.listBusinesses()) ?? []) {
    const code = normalizeRefCode(b.referralCode);
    if (!code) continue;
    const integration = await store.getIntegrationByBusiness?.(b.id);
    const subscription = await store.getSubscription?.(b.id);
    const leads = (await scopedToBusiness(store, b.id).listLeads()) ?? [];
    const firstLeadAt = leads
      .map((l) => l.createdAt)
      .filter((t) => Number.isFinite(Date.parse(t ?? "")))
      .sort()[0] ?? null;
    const paying = Boolean(subscription && subscription.plan !== "FREE" && subscription.status === "ACTIVE");
    rows.push({
      code,
      business: { id: b.id, name: b.name, createdAt: b.createdAt },
      connected: integration?.status === "CONNECTED",
      // When the WhatsApp connection was first made (kept across reconnects).
      connectedAt: integration?.createdAt ?? null,
      firstLeadAt,
      leads: leads.length,
      paying,
      payingSince: paying ? subscription.currentPeriodStart ?? subscription.updatedAt ?? null : null,
    });
  }
  return rows;
}

const rupees = (n) => `Rs ${n.toLocaleString("en-IN")}`;

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
  };
  const detail = process.argv.includes("--detail");
  const month = /^\d{4}-\d{2}$/.test(arg("--month") ?? "") ? arg("--month") : monthOf(Date.now());
  const only = normalizeRefCode(arg("--code"));

  const store = createRedisStore(loadEnv());
  const result = monthlyPayouts(await referralRows(store), month).filter((s) => !only || s.code === only);

  const R = REFERRAL_RULES;
  console.log(`Referral payouts for ${month}`);
  console.log(`Rules: ${rupees(R.perVerifiedConnect)} per verified connect (first lead within ${R.leadWindowDays} days), ` +
    `${rupees(R.payingBonus)} per business that starts paying, monthly bonus ` +
    R.monthlyBonus.slice().reverse().map((s) => `${s.atLeast}->${rupees(s.rupees)}`).join(", "));
  console.log("");

  if (!result.length) {
    console.log(only ? `No businesses signed up with code "${only}".` : "No referred businesses yet.");
    process.exit(0);
  }

  const cols = ["code", "signed up", "connected", "verified", "waiting", "paying", "connects", "bonus", "paying+", "TOTAL"];
  const widths = [16, 10, 10, 9, 8, 7, 11, 10, 9, 11];
  console.log(cols.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(""));
  for (const s of result) {
    const cells = [s.code, s.signups, s.connected, s.verified, s.waiting, s.paying, rupees(s.base), rupees(s.bonus), rupees(s.payingBonus), rupees(s.total)];
    console.log(cells.map((c, i) => (i ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join(""));
    if (detail) {
      for (const b of s.businesses) {
        const when = b.verifiedAt ? ` (verified ${b.verifiedAt.slice(0, 10)})` : "";
        console.log(`    - ${b.business.name || "(no name)"}  [signed up ${String(b.business.createdAt ?? "").slice(0, 10)}]  ` +
          `${b.state}${when}, ${b.leads} lead${b.leads === 1 ? "" : "s"}${b.paying ? ", paying" : ""}`);
      }
    }
  }
  console.log("");
  console.log("'verified' and 'paying' count only this month; 'waiting' = connected, first lead not in yet, still inside 14 days.");
}
