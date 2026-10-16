import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createMailer } from "../lib/mailer.mjs";
import { loginPage } from "../lib/views.mjs";
import { handleLogin } from "../routes/dashboard.mjs";
import {
  handleForgotGet, handleForgotPost, handleResetGet, handleResetPost,
} from "../routes/passwordReset.mjs";

const PW = "a-long-enough-password";
const NEW_PW = "a-brand-new-password";
const form = (f) => Buffer.from(new URLSearchParams(f).toString());
const post = (f, ip = "1.1.1.1") => ({ headers: { "x-forwarded-for": ip }, rawBody: form(f) });

function setup({ configured = true } = {}) {
  const store = createStore(null);
  const sent = [];
  const mailer = configured
    ? { configured: true, async send(m) { sent.push(m); return true; } }
    : createMailer({});
  const config = { PUBLIC_BASE_URL: "https://app.example.com/", META_APP_SECRET: "x" };
  return { store, sent, config, mailer, accounts: createAccountService(store), businesses: null };
}

const tokenFrom = (mail) => mail.text.match(/token=([0-9a-f]{64})/)[1];

test("the sign-in page links to forgot-password", () => {
  assert.match(loginPage(), /href="\/forgot-password"/);
});

test("forgot-password emails a reset link built from config, not the request", async () => {
  const d = setup();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  const res = await handleForgotPost({ ...post({ email: "A@Example.com" }), headers: { host: "evil.test", "x-forwarded-for": "1.1.1.1" } }, d);
  assert.equal(res.status, 200);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].to, "a@example.com");
  assert.match(d.sent[0].text, /^https:\/\/app\.example\.com\/reset-password\?token=[0-9a-f]{64}$/m);
  assert.ok(!d.sent[0].text.includes("evil.test"));
});

test("an unknown email gets the same response and no mail", async () => {
  const d = setup();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  const known = await handleForgotPost(post({ email: "a@example.com" }, "2.2.2.2"), d);
  const unknown = await handleForgotPost(post({ email: "nobody@example.com" }, "3.3.3.3"), d);
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.html, known.html);
  assert.equal(d.sent.length, 1);
});

test("with email unconfigured the page says so and sends nothing", async () => {
  const d = setup({ configured: false });
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  const res = await handleForgotPost(post({ email: "a@example.com" }), d);
  assert.equal(res.status, 503);
  assert.match(res.html, /available right now/);
});

test("reset emails to one address are capped", async () => {
  const d = setup();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  for (let i = 0; i < 6; i++) await handleForgotPost(post({ email: "a@example.com" }, `9.9.9.${i}`), d);
  assert.equal(d.sent.length, 3);
});

test("the link sets a new password once; the old one stops working", async () => {
  const d = setup();
  const user = await d.accounts.signUp({ email: "a@example.com", password: PW });
  await handleForgotPost(post({ email: "a@example.com" }), d);
  const token = tokenFrom(d.sent[0]);

  const page = await handleResetGet({ query: new URLSearchParams({ token }) }, d);
  assert.equal(page.status, 200);

  const done = await handleResetPost(post({ token, password: NEW_PW, confirm: NEW_PW }), d);
  assert.equal(done.status, 200);
  assert.match(done.html, /Password updated/);

  assert.equal((await d.accounts.authenticate({ email: "a@example.com", password: NEW_PW }))?.id, user.id);
  assert.equal(await d.accounts.authenticate({ email: "a@example.com", password: PW }), null);

  // Single use.
  const again = await handleResetPost(post({ token, password: "yet-another-password", confirm: "yet-another-password" }), d);
  assert.equal(again.status, 400);
  assert.equal((await handleResetGet({ query: new URLSearchParams({ token }) }, d)).status, 400);
});

test("a wrong, malformed or missing token changes nothing", async () => {
  const d = setup();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  for (const token of ["", "nope", "0".repeat(64)]) {
    const res = await handleResetPost(post({ token, password: NEW_PW, confirm: NEW_PW }), d);
    assert.equal(res.status, 400);
  }
  assert.ok(await d.accounts.authenticate({ email: "a@example.com", password: PW }));
});

test("a weak or mismatched new password is refused and the token stays usable", async () => {
  const d = setup();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  await handleForgotPost(post({ email: "a@example.com" }), d);
  const token = tokenFrom(d.sent[0]);

  assert.equal((await handleResetPost(post({ token, password: "short", confirm: "short" }), d)).status, 400);
  assert.equal((await handleResetPost(post({ token, password: NEW_PW, confirm: "different-password-1" }), d)).status, 400);
  assert.equal((await handleResetPost(post({ token, password: NEW_PW, confirm: NEW_PW }), d)).status, 200);
});

test("a reset token is not a session: it cannot be presented as a login cookie", async () => {
  const d = setup();
  const user = await d.accounts.signUp({ email: "a@example.com", password: PW });
  await handleForgotPost(post({ email: "a@example.com" }), d);
  // The stored record carries resetFor, never userId, so no session lookup can authenticate with it.
  const token = tokenFrom(d.sent[0]);
  const { default: crypto } = await import("node:crypto");
  const key = `pwreset-${crypto.createHash("sha256").update(token).digest("hex")}`;
  const record = await d.store.getSession(key);
  assert.equal(record.resetFor, user.id);
  assert.equal(record.userId, undefined);
});

test("GET forgot-password renders the form", () => {
  assert.equal(handleForgotGet().status, 200);
});

test("a password reset really lets the user sign in through POST /login", async () => {
  const d = setup();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  await handleForgotPost(post({ email: "a@example.com" }), d);
  await handleResetPost(post({ token: tokenFrom(d.sent[0]), password: NEW_PW, confirm: NEW_PW }), d);
  const res = await handleLogin(post({ email: "a@example.com", password: NEW_PW }, "7.7.7.7"), d);
  assert.equal(res.status, 302);
});
