/**
 * "Continue with Google" sign-in (OpenID Connect, authorization code flow).
 *
 * - Off unless GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and a public base URL
 *   are all set. The sign-in pages only show the button when it can work.
 * - The redirect URI is built from config, never from the request's Host.
 * - `state` is random, single use, expires in 10 minutes, and must match a
 *   cookie set on this browser, so a callback can't be replayed or forged
 *   from another browser. A `nonce` ties the ID token to this attempt.
 * - The ID token comes straight from Google's token endpoint over TLS with
 *   our client secret, so its claims are trusted after checking issuer,
 *   audience, expiry, nonce and that Google has verified the email.
 */
import crypto from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export const STATE_TTL_SECONDS = 10 * 60;
export const STATE_COOKIE = "mct_gstate";
export const CALLBACK_PATH = "/auth/google/callback";

export function googleAuthConfig(config = {}) {
  const clientId = String(config.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = String(config.GOOGLE_CLIENT_SECRET ?? "").trim();
  const base = String(config.PUBLIC_BASE_URL || config.WEBHOOK_BASE_URL || "").trim().replace(/\/$/, "");
  return {
    available: Boolean(clientId && clientSecret && base),
    clientId,
    clientSecret,
    redirectUri: base ? `${base}${CALLBACK_PATH}` : "",
  };
}

export function googleSignInAvailable(config) {
  return googleAuthConfig(config).available;
}

const stateKey = (state) => `gstate-${crypto.createHash("sha256").update(String(state)).digest("hex")}`;

/** Starts an attempt: stores state + nonce server-side and returns them. */
export async function beginGoogleSignIn(store) {
  const state = crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  await store.saveSession(stateKey(state), { purpose: "google-oauth", nonce, createdAt: new Date().toISOString() }, STATE_TTL_SECONDS);
  return { state, nonce };
}

/** Looks up and consumes a state. Null when unknown, expired or already used. */
export async function consumeGoogleState(store, state) {
  if (typeof state !== "string" || !/^[0-9a-f]{64}$/.test(state)) return null;
  const record = await store.getSession(stateKey(state));
  if (record?.purpose !== "google-oauth") return null;
  await store.deleteSession(stateKey(state));
  return record;
}

export function googleAuthUrl({ clientId, redirectUri, state, nonce }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export function stateCookie(state) {
  // Lax, not Strict: the callback is a top-level navigation coming back
  // from accounts.google.com, and a Strict cookie would not be sent on it.
  return `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth/google; Max-Age=${STATE_TTL_SECONDS}`;
}

export function clearedStateCookie() {
  return `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth/google; Max-Age=0`;
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Checks the ID token's claims. Returns { email, sub, name } or null. */
export function verifyIdTokenClaims(claims, { clientId, nonce, now = Date.now() }) {
  if (!claims || typeof claims !== "object") return null;
  if (!ISSUERS.has(claims.iss)) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  if (!nonce || claims.nonce !== nonce) return null;
  // Google sends a boolean; older tokens sent the string "true".
  if (claims.email_verified !== true && claims.email_verified !== "true") return null;
  if (typeof claims.email !== "string" || !claims.email || typeof claims.sub !== "string" || !claims.sub) return null;
  return { email: claims.email, sub: claims.sub, name: typeof claims.name === "string" ? claims.name : "" };
}

/** Swaps the authorization code for an ID token and checks it. Null on any failure. */
export async function exchangeGoogleCode({ code, clientId, clientSecret, redirectUri, nonce, fetchImpl = fetch }) {
  if (typeof code !== "string" || !code) return null;
  let res;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  let json;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return verifyIdTokenClaims(decodeJwtPayload(json?.id_token), { clientId, nonce });
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

/** The button and divider shown above the email form. Plain link, no script. */
export function googleButtonHtml(label = "Continue with Google") {
  return `
    <a class="google-btn" href="/auth/google">${GOOGLE_G}<span>${label}</span></a>
    <div class="or-divider"><span>or</span></div>`;
}

export const GOOGLE_BUTTON_STYLES = `
  .google-btn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%;
                min-height:48px; padding:0 16px; box-sizing:border-box; border:1px solid #dadce0; border-radius:3px;
                background:#fff; color:#1f1f1f; font-size:15px; font-weight:600; text-decoration:none; }
  .google-btn:hover { background:#f8faff; border-color:#c6d4f5; }
  .google-btn:focus-visible { outline:2px solid #4285F4; outline-offset:2px; }
  .or-divider { display:flex; align-items:center; gap:12px; margin:18px 0; color:var(--muted);
                font-size:12px; text-transform:uppercase; letter-spacing:.14em; }
  .or-divider::before, .or-divider::after { content:""; flex:1; height:1px; background:var(--line); }
`;
