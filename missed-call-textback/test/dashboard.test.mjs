import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseCookies, COOKIE_NAME } from "../lib/auth.mjs";
import { escapeHtml, dashboardPage } from "../lib/views.mjs";
import { handleLanding, handleDashboard, handleLogin, handleLogout } from "../routes/dashboard.mjs";
import { createTestDeps } from "./helpers.mjs";

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
  assert.match(res.html, /Sign out/);
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

test("the dashboard refuses to serve when no password is configured", async () => {
  const deps = createTestDeps({ DASHBOARD_PASSWORD_HASH: "" });
  const res = await handleDashboard({ headers: {} }, deps);
  assert.equal(res.status, 503);
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
