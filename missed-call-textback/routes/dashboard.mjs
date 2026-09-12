import { currentSession, createSession, verifyPassword, sessionCookie, clearedCookie, parseCookies, loginRateLimited, COOKIE_NAME } from "../lib/auth.mjs";
import { loginPage, dashboardPage } from "../lib/views.mjs";
import { log } from "../lib/logger.mjs";

/** GET / — the leads dashboard, or the login form when there's no valid session. */
export async function handleDashboard(ctx, { store, config }) {
  if (!config.DASHBOARD_PASSWORD_HASH) {
    return { status: 503, html: loginPage({ error: "Dashboard password is not configured." }) };
  }
  const session = await currentSession(ctx, store);
  if (!session) return { status: 200, html: loginPage() };

  const leads = await store.listLeads();
  return { status: 200, html: dashboardPage(leads) };
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
    headers: { Location: "/", "Set-Cookie": sessionCookie(id) },
    body: {},
  };
}

/** POST /logout — destroys the session server-side, not just the cookie. */
export async function handleLogout(ctx, { store }) {
  const id = parseCookies(ctx.headers?.cookie)[COOKIE_NAME];
  if (id) await store.deleteSession(id);
  return {
    status: 302,
    headers: { Location: "/", "Set-Cookie": clearedCookie() },
    body: {},
  };
}
