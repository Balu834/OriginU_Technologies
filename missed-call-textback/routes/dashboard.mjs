import { currentSession, createSession, verifyPassword, sessionCookie, clearedCookie, parseCookies, loginRateLimited, COOKIE_NAME } from "../lib/auth.mjs";
import { loginPage, dashboardPage } from "../lib/views.mjs";
import { isValidStatus } from "../lib/leads.mjs";
import { landingPage } from "../lib/landing.mjs";
import { log } from "../lib/logger.mjs";

/** GET / — the public pitch. No auth, no customer data on it. */
export function handleLanding(ctx, { config }) {
  return { status: 200, html: landingPage({ businessName: config.BUSINESS_NAME || "us" }) };
}

/** GET /leads — the leads dashboard, or the login form when there's no valid session. */
export async function handleDashboard(ctx, { store, config }) {
  if (!config.DASHBOARD_PASSWORD_HASH) {
    return { status: 503, html: loginPage({ error: "Dashboard password is not configured." }) };
  }
  const session = await currentSession(ctx, store);
  if (!session) return { status: 200, html: loginPage() };

  const query = {
    q: ctx.query?.get("q") ?? "",
    status: ctx.query?.get("status") ?? "",
    urgency: ctx.query?.get("urgency") ?? "",
  };

  const leads = await store.listLeads();
  return { status: 200, html: dashboardPage(leads, query) };
}

/**
 * POST /leads/status — moves one lead along the follow-up flow.
 *
 * Session-gated like the dashboard itself, and the status is checked
 * against the known set rather than written through, so a crafted form
 * post can't put arbitrary values on a lead.
 */
export async function handleLeadStatus(ctx, { store }) {
  const session = await currentSession(ctx, store);
  if (!session) return { status: 302, headers: { Location: "/leads" }, body: {} };

  const form = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
  const id = form.get("id") ?? "";
  const status = form.get("status") ?? "";
  const back = form.get("back") ?? "";

  if (!isValidStatus(status)) {
    log("lead_status_rejected", { reason: "unknown status" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  const lead = await store.getLead(id);
  if (!lead) {
    log("lead_status_rejected", { reason: "unknown lead" });
    return { status: 302, headers: { Location: "/leads" }, body: {} };
  }

  await store.saveLead({ ...lead, status, updatedAt: new Date().toISOString() });
  log("lead_status_changed", { leadId: id, status });

  // `back` only ever carries our own filter params; rebuilding it through
  // URLSearchParams keeps a crafted value from turning into an open redirect.
  const params = new URLSearchParams(back).toString();
  return { status: 302, headers: { Location: params ? `/leads?${params}` : "/leads" }, body: {} };
}

/** POST /login — verifies the password and starts a session. */
export async function handleLogin(ctx, { store, config }) {
  if (!config.DASHBOARD_PASSWORD_HASH) {
    return { status: 503, html: loginPage({ error: "Dashboard password is not configured." }) };
  }

  if (await loginRateLimited(ctx, store)) {
    log("dashboard_login_rate_limited", {});
    return { status: 429, html: loginPage({ error: "Too many attempts. Try again later." }) };
  }

  const submitted = new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "").get("password") ?? "";
  if (!verifyPassword(submitted, config.DASHBOARD_PASSWORD_HASH)) {
    log("dashboard_login_failed", {});
    return { status: 401, html: loginPage({ error: "Incorrect password." }) };
  }

  const id = await createSession(store);
  log("dashboard_login_succeeded", {});
  return {
    status: 302,
    headers: { Location: "/leads", "Set-Cookie": sessionCookie(id) },
    body: {},
  };
}

/** POST /logout — destroys the session server-side, not just the cookie. */
export async function handleLogout(ctx, { store }) {
  const id = parseCookies(ctx.headers?.cookie)[COOKIE_NAME];
  if (id) await store.deleteSession(id);
  return {
    status: 302,
    headers: { Location: "/leads", "Set-Cookie": clearedCookie() },
    body: {},
  };
}
