import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseCookies, COOKIE_NAME } from "../lib/auth.mjs";
import { escapeHtml, dashboardPage } from "../lib/views.mjs";
import { handleLanding, handleDashboard, handleLoginPage, handleLogin, handleLogout } from "../routes/dashboard.mjs";
import { createTestDeps } from "./helpers.mjs";
import { createAccountService } from "../lib/users.mjs";

const PASSWORD = "correct horse battery staple";

function depsWithPassword() {
  const deps = createTestDeps({ DASHBOARD_PASSWORD_HASH: hashPassword(PASSWORD) });
  return deps;
}

function formCtx(password, headers = {}) {
  return { headers, rawBody: Buffer.from(new URLSearchParams({ password }).toString()) };
}

test("password hashing round-trips and rejects a wrong password", () => {
  const stored = hashPassword(PASSWORD);
  assert.equal(verifyPassword(PASSWORD, stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
  assert.equal(verifyPassword(PASSWORD, "not-a-valid-hash"), false);
});

test("the stored hash never contains the plaintext password", () => {
  assert.ok(!hashPassword(PASSWORD).includes(PASSWORD));
});

test("cookies parse into a name/value map", () => {
  assert.deepEqual(parseCookies("a=1; mct_session=abc123"), { a: "1", mct_session: "abc123" });
  assert.deepEqual(parseCookies(undefined), {});
});

/**
 * An empty leads list has two meanings and the page has to say which:
 * nobody has replied yet, or nobody CAN reply because WhatsApp was never
 * connected. Only the second gets a call to action, and only when the
 * connection state was actually resolved — an unknown state must not be
 * rendered as either answer.
 */
test("the empty leads page explains itself only when it knows WhatsApp isn't connected", () => {
  const opts = { business: { name: "Planet" }, actor: { role: "OWNER" } };

  const unconnected = dashboardPage([], {}, { ...opts, whatsappStatus: "NOT_CONNECTED" });
  assert.match(unconnected, /none can arrive until WhatsApp is connected/);
  assert.match(unconnected, /href="\/settings\/whatsapp"[^>]*>Connect WhatsApp</);

  // Connected and simply quiet: no nagging, and no button to a step that
  // is already done.
  const connected = dashboardPage([], {}, { ...opts, whatsappStatus: "CONNECTED" });
  assert.match(connected, /They appear here the moment a customer replies/);
  assert.ok(!connected.includes(">Connect WhatsApp<"));

  // Unknown: says nothing about a connection it never looked up.
  const unknown = dashboardPage([], {}, opts);
  assert.match(unknown, /They appear here the moment a customer replies/);
  assert.ok(!unknown.includes(">Connect WhatsApp<"));

  // And a page with leads on it is never an empty state, connected or not.
  const withLeads = dashboardPage(
    [{ id: "1", status: "new", createdAt: new Date().toISOString(), name: "Ravi", callerNumber: "+919876543210" }],
    {}, { ...opts, whatsappStatus: "NOT_CONNECTED" }
  );
  assert.ok(!withLeads.includes("none can arrive until WhatsApp is connected"));
});

test("the leads subtitle never runs a count into the sentence when there is nothing to count", () => {
  const opts = { business: { name: "Planet" }, actor: { role: "OWNER" } };
  const sub = (html) => /<p class="sub"[^>]*>([\s\S]*?)<\/p>/.exec(html)[1].replace(/<[^>]+>/g, "").trim();

  assert.equal(sub(dashboardPage([], {}, opts)), "Every customer captured from your missed calls.");
  assert.match(
    sub(dashboardPage([{ id: "1", status: "new", createdAt: new Date().toISOString() }], {}, opts)),
    /missed calls\. 1 lead$/
  );
});

test("dashboard shows the login form when there is no session", async () => {
  const deps = depsWithPassword();
  const res = await handleDashboard({ headers: {} }, deps);
  assert.equal(res.status, 200);
  assert.match(res.html, /type="password"/);
  assert.doesNotMatch(res.html, /Sign out/);
});

test("wrong password is rejected and starts no session", async () => {
  const deps = depsWithPassword();
  const res = await handleLogin(formCtx("nope"), deps);
  assert.equal(res.status, 401);
  assert.equal(res.headers?.["Set-Cookie"], undefined);
});

test("correct password sets a hardened session cookie and redirects", async () => {
  const deps = depsWithPassword();
  const res = await handleLogin(formCtx(PASSWORD), deps);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/leads");
  const cookie = res.headers["Set-Cookie"];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

test("a session from login unlocks the leads view", async () => {
  const deps = depsWithPassword();
  await deps.store.saveLead({ id: "l1", callerNumber: "+919000000001", name: "Ravi", area: "Whitefield", problem: "AC not cooling", urgency: "today", createdAt: new Date().toISOString() });

  const login = await handleLogin(formCtx(PASSWORD), deps);
  const id = login.headers["Set-Cookie"].split(";")[0].split("=")[1];

  const res = await handleDashboard({ headers: { cookie: `${COOKIE_NAME}=${id}` } }, deps);
  assert.equal(res.status, 200);
  assert.match(res.html, /Ravi/);
  assert.match(res.html, /Whitefield/);
  // A way out must exist. Asserted as the form rather than its label, so
  // rewording the button doesn't fail the test while removing it does.
  assert.match(res.html, /action="\/logout"/, "the signed-in view offers no way to log out");
});

test("a forged session id does not unlock the leads view", async () => {
  const deps = depsWithPassword();
  await deps.store.saveLead({ id: "l1", callerNumber: "+919000000001", name: "Ravi", createdAt: new Date().toISOString() });

  const res = await handleDashboard({ headers: { cookie: `${COOKIE_NAME}=deadbeef` } }, deps);
  assert.doesNotMatch(res.html, /Ravi/);
  assert.match(res.html, /type="password"/);
});

test("logout destroys the session server-side, not just the cookie", async () => {
  const deps = depsWithPassword();
  const login = await handleLogin(formCtx(PASSWORD), deps);
  const id = login.headers["Set-Cookie"].split(";")[0].split("=")[1];

  await handleLogout({ headers: { cookie: `${COOKIE_NAME}=${id}` } }, deps);

  const res = await handleDashboard({ headers: { cookie: `${COOKIE_NAME}=${id}` } }, deps);
  assert.match(res.html, /type="password"/, "the destroyed session must no longer work");
});

test("repeated failed logins are rate limited", async () => {
  const deps = depsWithPassword();
  const ctx = () => formCtx("wrong", { "x-forwarded-for": "203.0.113.9" });

  let sawRateLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await handleLogin(ctx(), deps);
    if (res.status === 429) { sawRateLimit = true; break; }
  }
  assert.ok(sawRateLimit, "brute forcing the password must eventually be throttled");
});

/**
 * This test used to assert 503, and that assertion was the bug.
 *
 * DASHBOARD_PASSWORD_HASH is the LEGACY, deployment-wide, single-tenant
 * credential. It guarded the top of handleDashboard, handleLeadDetail,
 * handleLoginPage and handleLogin, so a deployment that had not set it
 * answered 503 to everyone — including people with real accounts, whose
 * signup had been allowed to succeed because handleSignupPost had no such
 * gate. Accounts you can create but never sign in to.
 *
 * Unconfigured now means what it should have meant all along: no session, so
 * you get the sign-in page and none of the data behind it.
 */
test("with no legacy password configured the dashboard shows the sign-in page, not a 503", async () => {
  const deps = createTestDeps({ DASHBOARD_PASSWORD_HASH: "" });
  const res = await handleDashboard({ headers: {} }, deps);

  assert.equal(res.status, 200);
  assert.match(res.html, /type="password"/, "an unauthenticated visitor must still be offered a sign-in form");
  assert.doesNotMatch(res.html, /<table/, "no lead table may be served without a session");
});

test("the sign-in page renders when no legacy password is configured", async () => {
  const deps = createTestDeps({ DASHBOARD_PASSWORD_HASH: "" });
  const res = await handleLoginPage({ headers: {} }, deps);

  assert.equal(res.status, 200);
  assert.match(res.html, /name="email"/);
  assert.match(res.html, /name="password"/);
});

/**
 * The regression the 503 was hiding: a real account must be able to sign in
 * on a deployment that never set the legacy hash.
 */
test("an account signs in with email and password even when no legacy hash exists", async () => {
  const deps = createTestDeps({ DASHBOARD_PASSWORD_HASH: "" });
  deps.accounts = createAccountService(deps.store);

  const email = "owner@example.com";
  const password = "a-long-enough-password";
  await deps.accounts.signUp({ email, password });

  const res = await handleLogin({
    headers: {},
    rawBody: Buffer.from(new URLSearchParams({ email, password }).toString()),
  }, deps);

  assert.equal(res.status, 302, "a valid account was refused because the legacy hash was absent");
  assert.match(res.headers["Set-Cookie"], new RegExp(`^${COOKIE_NAME}=`));

  const wrong = await handleLogin({
    headers: {},
    rawBody: Buffer.from(new URLSearchParams({ email, password: "not-the-password" }).toString()),
  }, deps);
  assert.equal(wrong.status, 401, "a wrong password must still be refused");
});

/**
 * And the other half: with no hash and no account, a password-only sign-in
 * fails closed. This is what the 503 was really protecting, and it still holds
 * without coupling account auth to a legacy env var.
 */
test("a password-only sign-in fails closed when no legacy hash is configured", async () => {
  const deps = createTestDeps({ DASHBOARD_PASSWORD_HASH: "" });
  const res = await handleLogin(formCtx("anything-at-all"), deps);
  assert.equal(res.status, 401);
});

test("the public landing page serves without a session", async () => {
  const deps = depsWithPassword();
  const res = await handleLanding({ headers: {} }, deps);
  assert.equal(res.status, 200);
  assert.match(res.html, /how it works/i);
  assert.doesNotMatch(res.html, /type="password"/, "the pitch page should not be a login form");
});

test("every link on the landing page points at a route that exists", async () => {
  const { NON_JSON_POSTS } = await import("../routes/router.mjs");
  const routerSource = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../routes/router.mjs", import.meta.url), "utf8"));

  // The GET routes the dispatch table actually serves.
  const servesGet = new Set(
    [...routerSource.matchAll(/\["GET",\s*"([^"]+)"/g)].map((m) => m[1])
  );

  const html = (await handleLanding({ headers: {} }, depsWithPassword())).html;
  const targets = [...new Set([...html.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))];
  assert.ok(targets.length > 0, "the page has no links at all");

  for (const target of targets) {
    assert.ok(
      servesGet.has(target),
      `the landing page links to ${target}, which has no GET route — visitors would get a 404`
    );
  }

  // The specific trap: /login is POST-only, so the sign-in link has to be
  // the page that actually renders the form.
  assert.ok(!targets.includes("/login"), "/login is POST-only and would 404 as a link");
  assert.ok(targets.includes("/leads"), "there is no route to sign in from");
  assert.ok(targets.includes("/signup"), "there is no route to sign up from");
  assert.ok(NON_JSON_POSTS.has("/login"), "assumption changed: /login is no longer a POST route");
});

test("the landing page advertises the real plan prices and limits", async () => {
  const { PLAN_ENTITLEMENTS, formatPrice } = await import("../lib/billing.mjs");
  const html = (await handleLanding({ headers: {} }, depsWithPassword())).html;

  // Whatever billing says today must be what the pitch says.
  assert.ok(html.includes(formatPrice("PRO")), "the advertised Pro price is not the configured one");
  assert.ok(html.includes(String(PLAN_ENTITLEMENTS.FREE.leadsPerMonth)), "the free lead allowance is not shown");
  assert.ok(html.includes(String(PLAN_ENTITLEMENTS.PRO.leadsPerMonth)), "the Pro lead allowance is not shown");

  // Claims the product cannot honour.
  for (const claim of [/unlimited/i, /free trial/i, /\b7[- ]day/i, /cancel anytime/i]) {
    assert.doesNotMatch(html, claim, `the landing page makes a claim the product does not implement: ${claim}`);
  }
});

test("the landing page leaks no lead data, session or not", async () => {
  const deps = depsWithPassword();
  // Values deliberately unlike anything in the page's own sample conversation,
  // so a hit means real stored data escaped rather than matching illustrative copy.
  await deps.store.saveLead({
    id: "l9", callerNumber: "+915550001234", name: "Zzyzx Quimby", area: "Nowhereville",
    problem: "flux capacitor sparking", createdAt: new Date().toISOString(),
  });

  const res = await handleLanding({ headers: {} }, deps);
  assert.doesNotMatch(res.html, /Zzyzx Quimby/);
  assert.doesNotMatch(res.html, /915550001234/);
  assert.doesNotMatch(res.html, /Nowhereville/);
});

test("escapeHtml neutralises markup", () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(`" onload="x`), "&quot; onload=&quot;x");
});

test("customer-controlled lead text cannot inject script into the page", () => {
  const html = dashboardPage([
    {
      id: "x",
      callerNumber: "+919000000002",
      name: '<script>alert("pwned")</script>',
      problem: '<img src=x onerror=alert(1)>',
      area: "Whitefield",
      urgency: "today",
      createdAt: new Date().toISOString(),
    },
  ]);

  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;script&gt;/);
});

test("emergency leads are marked urgent in the rendered page", () => {
  const html = dashboardPage([
    { id: "e", callerNumber: "+919000000003", name: "Priya", problem: "socket sparking", emergency: true, createdAt: new Date().toISOString() },
  ]);
  assert.match(html, /URGENT/);
});

/**
 * GET /login used to fall through the dispatch table.
 *
 * The sign-in form only ever existed as what GET /leads renders without a
 * session, and nothing answered GET /login — so the one URL a visitor is most
 * likely to type, and the one the landing page's "Login" button invites them to
 * guess, returned the raw {"error":"not found"} JSON in production.
 */
test("GET /login serves the sign-in page rather than a JSON error", async () => {
  const deps = depsWithPassword();
  const res = await handleLoginPage({ headers: {} }, deps);

  assert.equal(res.status, 200);
  assert.match(res.html, /type="password"/, "GET /login must render the sign-in form");
  assert.match(res.html, /action="\/login"/, "the form must post back to /login");
});

test("GET /login sends a signed-in visitor to their leads instead of a login form", async () => {
  const deps = depsWithPassword();
  const login = await handleLogin(formCtx(PASSWORD), deps);
  const id = login.headers["Set-Cookie"].split(";")[0].split("=")[1];

  const res = await handleLoginPage({ headers: { cookie: `${COOKIE_NAME}=${id}` } }, deps);

  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "/leads");
});

/**
 * The sign-in page is the first thing a new customer sees, and it is shared by
 * every tenant. It carried the name of the business this was originally built
 * for, so everyone who signed up was greeted by a stranger's company.
 */
test("the sign-in page carries the product name, not a tenant's", async () => {
  const deps = depsWithPassword();
  const res = await handleLoginPage({ headers: {} }, deps);

  assert.doesNotMatch(res.html, /Planet Electrical/, "a tenant name must not appear on the shared sign-in page");
  assert.match(res.html, /MissedCall/);
});

/**
 * Same defect as the sign-in page above, one page over and harder to see:
 * the public marketing homepage took BUSINESS_NAME — the legacy
 * single-tenant config — and printed "Run by <that tenant>." in its footer.
 * Every visitor to the product's own front page was told it was run by one
 * customer. The test fixtures set BUSINESS_NAME, so rendering with them is
 * the condition that used to reproduce it.
 */
test("the public landing page carries no tenant's name, even when one is configured", () => {
  const deps = createTestDeps({ BUSINESS_NAME: "Planet Electrical" });
  const res = handleLanding({ headers: {} }, deps);

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.html, /Planet Electrical/, "a tenant name must not appear on the shared landing page");
  assert.doesNotMatch(res.html, /Run by/, "the footer must not attribute the product to one business");
  assert.match(res.html, /MissedCall/);
});
