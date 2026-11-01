/**
 * Referral codes: which marketer brought in which business.
 *
 * A marketer shares a link with their code, e.g.
 *   https://missedcall.originutech.in/?ref=ravi   or   /signup?ref=ravi
 * Opening it stores the code in a cookie for 30 days. When that visitor
 * finishes onboarding (the moment a business is actually created) the code
 * is stamped on the business. Google sign-in in between is fine: the cookie
 * is SameSite=Lax, so it survives the trip to Google and back.
 *
 * First link wins: a later link does not overwrite an earlier code, so one
 * marketer can't take over a signup another one started.
 *
 * Nothing here pays anyone. `monthlyPayouts` works out, per code and per
 * month, what is owed under REFERRAL_RULES, and scripts/referral-report.mjs
 * prints it.
 */

export const REF_COOKIE = "mc_ref";
const REF_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A clean code (2–32 of a-z, 0-9, _ or -, lower-cased), or "" for anything else. */
export function normalizeRefCode(raw) {
  const code = String(raw ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{2,32}$/.test(code) ? code : "";
}

function cookiesOf(ctx) {
  const header = ctx?.headers?.cookie;
  if (typeof header !== "string") return {};
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The code this visitor arrived with (from the cookie), or "". */
export function referralFromRequest(ctx) {
  return normalizeRefCode(cookiesOf(ctx)[REF_COOKIE]);
}

/**
 * The Set-Cookie value to remember `?ref=` on this request, or null when
 * there is no valid code or the visitor already carries one (first wins).
 */
export function referralCookieFor(ctx) {
  const code = normalizeRefCode(ctx?.query?.get?.("ref"));
  if (!code || referralFromRequest(ctx)) return null;
  return `${REF_COOKIE}=${code}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${REF_TTL_SECONDS}`;
}

/** Clears the code once it has been stamped on a business. */
export function clearedReferralCookie() {
  return `${REF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Adds a Set-Cookie value to a route result's headers, keeping any already there. */
export function withCookie(result, cookie) {
  if (!cookie) return result;
  const headers = { ...(result.headers ?? {}) };
  const existing = headers["Set-Cookie"];
  headers["Set-Cookie"] = existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie;
  return { ...result, headers };
}

/**
 * The agreed payout rules for marketers.
 *
 * - A connect only counts once it is VERIFIED: the business connected its
 *   WhatsApp and then got its first real lead within `leadWindowDays`.
 *   Real businesses get there quickly; signed-up-for-the-money ones don't.
 * - Rs `perVerifiedConnect` each, counted in the month it was verified.
 * - A one-time Rs `payingBonus` when a referred business becomes paying,
 *   counted in the month it started paying.
 * - A monthly step bonus on the month's verified connects (highest step
 *   reached only, not added together).
 */
export const REFERRAL_RULES = {
  perVerifiedConnect: 100,
  leadWindowDays: 14,
  payingBonus: 200,
  monthlyBonus: [
    { atLeast: 300, rupees: 5000 },
    { atLeast: 150, rupees: 2500 },
    { atLeast: 50, rupees: 1000 },
  ],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ms = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : null;
};

/** "2026-11" for a time, in India time (where the marketers are paid). */
export function monthOf(isoOrMs) {
  const t = typeof isoOrMs === "number" ? isoOrMs : ms(isoOrMs);
  if (t === null) return null;
  return new Date(t + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/**
 * Where one referred business stands.
 *
 * `row` is { connected, connectedAt, firstLeadAt, paying, payingSince }.
 * Returns { state, verifiedAt } where state is one of:
 *   "not connected", "waiting for first lead" (inside the window),
 *   "verified", "no lead in time" (window passed without a lead).
 */
export function referralState(row, now = Date.now(), rules = REFERRAL_RULES) {
  const connectedAt = ms(row.connectedAt);
  if (!row.connected || connectedAt === null) return { state: "not connected", verifiedAt: null };
  const windowEnds = connectedAt + rules.leadWindowDays * DAY_MS;
  const firstLeadAt = ms(row.firstLeadAt);
  if (firstLeadAt !== null && firstLeadAt <= windowEnds) {
    return { state: "verified", verifiedAt: Math.max(firstLeadAt, connectedAt) };
  }
  return { state: now <= windowEnds ? "waiting for first lead" : "no lead in time", verifiedAt: null };
}

export function monthlyBonusFor(verifiedCount, rules = REFERRAL_RULES) {
  const step = rules.monthlyBonus.find((s) => verifiedCount >= s.atLeast);
  return step ? step.rupees : 0;
}

/**
 * What each code earned in `month` ("2026-11").
 *
 * `rows` is one entry per referred business:
 *   { code, business: { id, name, createdAt }, connected, connectedAt,
 *     firstLeadAt, leads, paying, payingSince }
 * Codes with nothing at all are left out; codes with businesses but no
 * payout this month are kept, so pending work is visible.
 */
export function monthlyPayouts(rows, month, { now = Date.now(), rules = REFERRAL_RULES } = {}) {
  const byCode = new Map();
  for (const r of rows) {
    const code = normalizeRefCode(r.code);
    if (!code) continue;
    const s = byCode.get(code) ?? {
      code, signups: 0, connected: 0, verified: 0, waiting: 0, expired: 0, paying: 0,
      base: 0, bonus: 0, payingBonus: 0, total: 0, businesses: [],
    };
    const { state, verifiedAt } = referralState(r, now, rules);
    s.signups += 1;
    if (r.connected) s.connected += 1;
    if (state === "verified" && monthOf(verifiedAt) === month) s.verified += 1;
    if (state === "waiting for first lead") s.waiting += 1;
    if (state === "no lead in time") s.expired += 1;
    if (r.paying && monthOf(r.payingSince) === month) s.paying += 1;
    s.businesses.push({ ...r, state, verifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null });
    byCode.set(code, s);
  }
  for (const s of byCode.values()) {
    s.base = s.verified * rules.perVerifiedConnect;
    s.bonus = monthlyBonusFor(s.verified, rules);
    s.payingBonus = s.paying * rules.payingBonus;
    s.total = s.base + s.bonus + s.payingBonus;
  }
  return [...byCode.values()].sort((a, b) => b.total - a.total || b.signups - a.signups || a.code.localeCompare(b.code));
}
