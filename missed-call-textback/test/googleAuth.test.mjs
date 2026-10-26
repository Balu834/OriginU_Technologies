import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.mjs";
import { createAccountService, createMembership } from "../lib/users.mjs";
import { loginPage } from "../lib/views.mjs";
import { signupPage } from "../lib/settingsViews.mjs";
import { googleAuthConfig, verifyIdTokenClaims, STATE_COOKIE } from "../lib/googleAuth.mjs";
import { handleGoogleStart, handleGoogleCallback } from "../routes/googleAuth.mjs";
import { handleLoginPage } from "../routes/dashboard.mjs";
import { COOKIE_NAME } from "../lib/auth.mjs";

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const CONFIG = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "shh", PUBLIC_BASE_URL: "https://app.example.com/" };

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function setup({ claims, tokenStatus = 200 } = {}) {
  const store = createStore(null);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return { ok: tokenStatus === 200, status: tokenStatus, json: async () => ({ id_token: jwt(claims(calls.at(-1))) }) };
  };
  return { store, calls, config: CONFIG, accounts: createAccountService(store), fetchImpl };
}

const goodClaims = (nonce, extra = {}) => ({
  iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300,
  nonce, email: "Owner@Example.com", email_verified: true, sub: "google-sub-1", name: "Owner", ...extra,
});

/** Runs start, then the callback the way Google would send it back. */
async function signIn(d, { tamperState = false, code = "auth-code", cookieState } = {}) {
  const start = await handleGoogleStart({ headers: { "x-forwarded-for": "9.9.9.9" } }, d);
  const location = new URL(start.headers.Location);
  const state = location.searchParams.get("state");
  d.lastNonce = location.searchParams.get("nonce");
  const sentState = tamperState ? "f".repeat(64) : state;
  const query = new URLSearchParams({ state: sentState, code });
  return handleGoogleCallback(
    { query, headers: { cookie: `${STATE_COOKIE}=${cookieState ?? state}` } },
    d
  );
}

const sessionIdFrom = (res) => {
  const cookies = [].concat(res.headers["Set-Cookie"]);
  const c = cookies.find((x) => x.startsWith(`${COOKIE_NAME}=`));
  return c ? c.split(";")[0].split("=")[1] : null;
};

test("the button only shows when Google sign-in is fully configured", () => {
  assert.equal(googleAuthConfig(CONFIG).available, true);
  assert.equal(googleAuthConfig({ ...CONFIG, GOOGLE_CLIENT_SECRET: "" }).available, false);
  assert.equal(googleAuthConfig({ ...CONFIG, PUBLIC_BASE_URL: "" }).available, false);
  assert.match(loginPage({ google: true }), /href="\/auth\/google"/);
  assert.doesNotMatch(loginPage(), /\/auth\/google/);
  assert.match(signupPage({ google: true }), /Sign up with Google/);
  assert.doesNotMatch(signupPage(), /\/auth\/google/);
});

test("the sign-in page shows the button when configured", async () => {
  const d = setup();
  const res = await handleLoginPage({ headers: {} }, d);
  assert.match(res.html, /Continue with Google/);
  const off = await handleLoginPage({ headers: {} }, { ...d, config: {} });
  assert.doesNotMatch(off.html, /Continue with Google/);
});

test("start redirects to Google with a redirect URI from config, not the request", async () => {
  const d = setup();
  const res = await handleGoogleStart({ headers: { host: "evil.test" } }, d);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.Location);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/auth/google/callback");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.match(url.searchParams.get("scope"), /openid/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Lax/);
});

test("a new Google user gets an account and is sent to onboarding", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce) });
  const res = await signIn(d);
  assert.equal(res.status, 200);
  assert.match(res.html, /url=\/onboarding/);
  const session = await d.store.getSession(sessionIdFrom(res));
  const user = await d.accounts.findByEmail("owner@example.com");
  assert.equal(session.userId, user.id);
  assert.equal(user.googleSub, "google-sub-1");
  assert.equal(d.calls[0].body.get("client_secret"), "shh");
  assert.equal(d.calls[0].body.get("redirect_uri"), "https://app.example.com/auth/google/callback");
});

test("an existing owner with a business lands on their leads", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce) });
  const user = await d.accounts.signUp({ email: "owner@example.com", password: "a-long-enough-password" });
  await d.store.saveMembership(createMembership({ userId: user.id, businessId: "biz-1", role: "OWNER" }));
  const res = await signIn(d);
  assert.match(res.html, /url=\/leads/);
  const session = await d.store.getSession(sessionIdFrom(res));
  assert.equal(session.userId, user.id);
  assert.equal(session.businessId, "biz-1");
  // Linking doesn't touch the password: it still works.
  assert.ok(await d.accounts.authenticate({ email: "owner@example.com", password: "a-long-enough-password" }));
});

test("once linked, a different Google account can't take over the email", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce) });
  await signIn(d);
  const other = setup({ claims: () => goodClaims(other.lastNonce, { sub: "someone-else" }) });
  other.store = d.store;
  other.accounts = d.accounts;
  const res = await signIn(other);
  assert.equal(res.status, 403);
  assert.equal(sessionIdFrom(res), null);
});

test("an unverified Google email is refused", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce, { email_verified: false }) });
  const res = await signIn(d);
  assert.equal(res.status, 400);
  assert.equal(sessionIdFrom(res), null);
  assert.equal(await d.accounts.findByEmail("owner@example.com"), null);
});

test("a state that doesn't match this browser's cookie is refused", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce) });
  const res = await signIn(d, { cookieState: "0".repeat(64) });
  assert.equal(res.status, 400);
  assert.equal(d.calls.length, 0, "no code exchange without a valid state");
});

test("a state can only be used once", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce) });
  const start = await handleGoogleStart({ headers: {} }, d);
  const url = new URL(start.headers.Location);
  d.lastNonce = url.searchParams.get("nonce");
  const state = url.searchParams.get("state");
  const ctx = { query: new URLSearchParams({ state, code: "c" }), headers: { cookie: `${STATE_COOKIE}=${state}` } };
  assert.equal((await handleGoogleCallback(ctx, d)).status, 200);
  assert.equal((await handleGoogleCallback(ctx, d)).status, 400);
});

test("a token for another app, an old token, or the wrong nonce is refused", () => {
  const ok = goodClaims("n1");
  assert.ok(verifyIdTokenClaims(ok, { clientId: CLIENT_ID, nonce: "n1" }));
  assert.equal(verifyIdTokenClaims({ ...ok, aud: "other-app" }, { clientId: CLIENT_ID, nonce: "n1" }), null);
  assert.equal(verifyIdTokenClaims({ ...ok, iss: "https://evil.test" }, { clientId: CLIENT_ID, nonce: "n1" }), null);
  assert.equal(verifyIdTokenClaims({ ...ok, exp: 1 }, { clientId: CLIENT_ID, nonce: "n1" }), null);
  assert.equal(verifyIdTokenClaims(ok, { clientId: CLIENT_ID, nonce: "n2" }), null);
});

test("a failed code exchange signs nobody in", async () => {
  const d = setup({ claims: () => goodClaims(d.lastNonce), tokenStatus: 400 });
  const res = await signIn(d);
  assert.equal(res.status, 400);
  assert.equal(sessionIdFrom(res), null);
});

test("cancelling on Google's screen shows a friendly message", async () => {
  const d = setup();
  const res = await handleGoogleCallback({ query: new URLSearchParams({ error: "access_denied" }), headers: {} }, d);
  assert.equal(res.status, 200);
  assert.match(res.html, /cancelled/);
});

test("with Google unconfigured the routes don't start anything", async () => {
  const d = { ...setup(), config: {} };
  assert.equal((await handleGoogleStart({ headers: {} }, d)).status, 404);
  assert.equal((await handleGoogleCallback({ query: new URLSearchParams(), headers: {} }, d)).status, 404);
});
