/**
 * Forgot / reset password.
 *
 * - The emailed token is 32 random bytes; only its SHA-256 is stored, under a
 *   key no session cookie can usefully address (the record carries `resetFor`,
 *   not `userId`, so it never confers a session even if looked up as one).
 * - Single use, expires in 1 hour.
 * - POST /forgot-password answers identically whether or not the address has
 *   an account, and is throttled per IP and per address.
 * - The link's host comes from config, never from the request.
 */
import crypto from "node:crypto";
import { loginRateLimited } from "../lib/auth.mjs";
import { isValidEmail, normaliseEmail, isAcceptablePassword } from "../lib/users.mjs";
import { createMailer } from "../lib/mailer.mjs";
import { forgotPasswordPage, resetPasswordPage, resetLinkInvalidPage } from "../lib/resetViews.mjs";
import { loginPage } from "../lib/views.mjs";
import { log } from "../lib/logger.mjs";

const TOKEN_TTL_SECONDS = 60 * 60;
const EMAIL_WINDOW_SECONDS = 60 * 60;
const MAX_EMAILS_PER_ADDRESS = 3;

const formOf = (ctx) => new URLSearchParams(ctx.rawBody?.toString("utf8") ?? "");
const keyFor = (token) => `pwreset-${crypto.createHash("sha256").update(String(token)).digest("hex")}`;

function baseUrl(config) {
  return String(config?.PUBLIC_BASE_URL || config?.WEBHOOK_BASE_URL || "").replace(/\/$/, "");
}

async function lookupToken(store, token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const record = await store.getSession(keyFor(token));
  return record?.purpose === "pwreset" && record.resetFor ? record : null;
}

export function handleForgotGet() {
  return { status: 200, html: forgotPasswordPage() };
}

export async function handleForgotPost(ctx, deps) {
  const { store, accounts, config } = deps;
  const mailer = deps.mailer ?? createMailer(config);
  const base = baseUrl(config);

  if (await loginRateLimited(ctx, store)) {
    return { status: 429, html: forgotPasswordPage({ error: "Too many attempts. Try again later." }) };
  }

  // Honest about a missing mail setup: that is deployment state, not
  // information about any account.
  if (!mailer.configured || !base) {
    log("password_reset_unavailable", {});
    return {
      status: 503,
      html: forgotPasswordPage({ error: "Email reset isn't available right now. Email support@originutech.in and we'll reset it for you." }),
    };
  }

  const email = normaliseEmail(formOf(ctx).get("email"));
  if (!isValidEmail(email)) {
    return { status: 400, html: forgotPasswordPage({ error: "Enter a valid email address." }) };
  }

  const sent = { status: 200, html: forgotPasswordPage({ sent: true }) };

  const perAddress = await store.bumpRateLimit(`forgot-email:${email}`, EMAIL_WINDOW_SECONDS);
  if (perAddress > MAX_EMAILS_PER_ADDRESS) return sent; // quiet: no mail-bombing, no signal

  const user = await accounts.findByEmail(email);
  if (!user) {
    log("password_reset_unknown_email", {});
    return sent;
  }

  const token = crypto.randomBytes(32).toString("hex");
  await store.saveSession(keyFor(token), { purpose: "pwreset", resetFor: user.id }, TOKEN_TTL_SECONDS);

  const ok = await mailer.send({
    to: user.email,
    subject: "Reset your MissedCall password",
    text: `Someone asked to reset the password for this MissedCall account.\n\nReset it here (works once, expires in 1 hour):\n${base}/reset-password?token=${token}\n\nIf you didn't ask for this, ignore this email - your password stays the same.`,
  });
  log(ok ? "password_reset_sent" : "password_reset_send_failed", {});
  return sent;
}

export async function handleResetGet(ctx, { store }) {
  const token = ctx.query?.get("token") ?? "";
  if (!(await lookupToken(store, token))) return { status: 400, html: resetLinkInvalidPage() };
  return { status: 200, html: resetPasswordPage({ token }) };
}

export async function handleResetPost(ctx, { store, accounts }) {
  if (await loginRateLimited(ctx, store)) {
    return { status: 429, html: resetLinkInvalidPage() };
  }

  const form = formOf(ctx);
  const token = form.get("token") ?? "";
  const record = await lookupToken(store, token);
  if (!record) return { status: 400, html: resetLinkInvalidPage() };

  const password = form.get("password") ?? "";
  if (!isAcceptablePassword(password)) {
    return { status: 400, html: resetPasswordPage({ token, error: "Password must be at least 10 characters." }) };
  }
  if (password !== (form.get("confirm") ?? "")) {
    return { status: 400, html: resetPasswordPage({ token, error: "The two passwords don't match." }) };
  }

  if (!(await accounts.setPassword(record.resetFor, password))) {
    return { status: 400, html: resetLinkInvalidPage() };
  }
  await store.deleteSession(keyFor(token)); // single use
  log("password_reset_completed", {});
  return { status: 200, html: loginPage({ notice: "Password updated. Sign in with your new password." }) };
}
