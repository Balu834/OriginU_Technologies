/**
 * Password + session handling for the leads dashboard.
 *
 * The dashboard shows customer PII (names, numbers, stated problems) on a
 * public URL, so this is real auth, not obscurity: scrypt-hashed password,
 * constant-time comparison, random session ids in HttpOnly cookies, and a
 * windowed attempt limit so the login can't be brute-forced.
 *
 * DASHBOARD_PASSWORD_HASH holds "salt:hash" — generate one with
 * `node scripts/hash-password.mjs <password>`. The plaintext is never
 * stored anywhere.
 */
import crypto from "node:crypto";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const COOKIE_NAME = "mct_session";

const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 10;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;

  let derived;
  try {
    derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  } catch {
    return false;
  }
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(cookieHeader) {
  if (typeof cookieHeader !== "string") return {};
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf("=");
        return i === -1 ? [part, ""] : [part.slice(0, i), decodeURIComponent(part.slice(i + 1))];
      })
  );
}

export function sessionCookie(id) {
  return `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Resolves the session for a request, or null when there isn't a valid one. */
export async function currentSession(ctx, store) {
  const id = parseCookies(ctx.headers?.cookie)[COOKIE_NAME];
  if (!id) return null;
  return store.getSession(id);
}

export async function createSession(store) {
  const id = crypto.randomBytes(32).toString("hex");
  await store.saveSession(id, { createdAt: new Date().toISOString() }, SESSION_TTL_SECONDS);
  return id;
}

/**
 * Throttles by client IP. Returns true when the caller has already used up
 * its attempts for the current window.
 */
export async function loginRateLimited(ctx, store) {
  const ip = String(ctx.headers?.["x-forwarded-for"] ?? "unknown").split(",")[0].trim() || "unknown";
  const attempts = await store.bumpRateLimit(`login:${ip}`, LOGIN_WINDOW_SECONDS);
  return attempts > MAX_LOGIN_ATTEMPTS;
}
