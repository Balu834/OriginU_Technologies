/**
 * Embedded Signup in the same tab, for phones.
 *
 * WHY THIS EXISTS. On a computer, Meta's flow opens in a popup and hands
 * the code back to the page that opened it (`FB.login`'s callback, fed by
 * a postMessage from Meta's relay page to `window.opener`). On a phone the
 * "popup" is a new tab, and that tab loses its link back to our page part
 * way through Meta's flow. From then on the SDK reports the popup closed
 * and fires the callback with `authResponse: null`, and nothing Meta posts
 * afterwards (the code, the WA_EMBEDDED_SIGNUP message) can reach us. The
 * owner finishes on "Please close this tab", Meta has linked their number,
 * and we were never told. Every phone attempt in production ended this way.
 *
 * So on a phone the page does not open a tab at all. It sends the owner's
 * own tab to Meta's OAuth dialog (the documented manual Facebook Login for
 * Business flow, with the same config_id and extras the SDK sends), and
 * Meta sends that tab back to GET /settings/whatsapp/callback with the
 * code. No opener, no postMessage, nothing that depends on the page that
 * started it still being alive.
 *
 * WHAT KEEPS IT SAFE.
 *
 * - `state` is 32 random bytes, single use, 30 minutes, stored server-side
 *   with the business and user that started it, and must match a cookie
 *   set on this browser. A dialog link started by someone else (say, an
 *   attacker who sends an owner the link for the attacker's business) dies
 *   at the callback, because the owner's browser does not have that cookie.
 * - The cookie is SameSite=Lax because the return from facebook.com is a
 *   cross-site top-level navigation, and the session cookie is Strict, so
 *   it is not sent on that request. The state record, not the request,
 *   says which business this is, and the callback re-checks the membership
 *   and role before doing anything.
 * - The redirect_uri is built from config, never from the request's Host.
 * - The code reaches us in the callback's query string, because that is
 *   how OAuth returns one; it is the only place a code is ever in a URL.
 *   It is useless without our app secret, it is spent at once, it is
 *   never logged, and the callback's page replaces its own address and
 *   sends no Referer, so it does not stay in history or leak onward.
 */
import crypto from "node:crypto";

export const SIGNUP_CALLBACK_PATH = "/settings/whatsapp/callback";
export const SIGNUP_STATE_COOKIE = "mct_wastate";

/** Long enough to log in, create a WhatsApp account and verify a number by SMS. */
export const SIGNUP_STATE_TTL_SECONDS = 30 * 60;

/**
 * The two connect buttons. "app" keeps the number on the owner's WhatsApp
 * Business app (Meta coexistence); "api" uses a number not on WhatsApp.
 * The values are Embedded Signup's `featureType`, exactly as the popup
 * flow sends them.
 */
export const SIGNUP_MODES = {
  app: "whatsapp_business_app_onboarding",
  api: "",
};

export function signupMode(value) {
  return value === "app" ? "app" : "api";
}

/** <public base>/settings/whatsapp/callback, or "" when no base URL is configured. */
export function signupRedirectUri(config = {}) {
  const base = String(config.PUBLIC_BASE_URL || config.WEBHOOK_BASE_URL || "").trim().replace(/\/$/, "");
  return /^https?:\/\//.test(base) ? `${base}${SIGNUP_CALLBACK_PATH}` : "";
}

const stateKey = (state) => `wastate-${crypto.createHash("sha256").update(String(state)).digest("hex")}`;

/**
 * Starts one same-tab attempt for the business and user that are signed in
 * now. Only a hash of `state` is used as the store key, so the store never
 * holds the value the browser carries.
 */
export async function beginSignupRedirect(store, { businessId, userId = null, mode = "api" }) {
  const state = crypto.randomBytes(32).toString("hex");
  await store.saveSession(stateKey(state), {
    purpose: "whatsapp-signup",
    businessId,
    userId,
    mode: signupMode(mode),
    createdAt: new Date().toISOString(),
  }, SIGNUP_STATE_TTL_SECONDS);
  return { state };
}

/** Looks up and spends a state. Null when malformed, unknown, expired or already used. */
export async function consumeSignupState(store, state) {
  if (typeof state !== "string" || !/^[0-9a-f]{64}$/.test(state)) return null;
  const record = await store.getSession(stateKey(state));
  if (record?.purpose !== "whatsapp-signup" || !record.businessId) return null;
  await store.deleteSession(stateKey(state));
  return record;
}

/**
 * Meta's OAuth dialog with Embedded Signup's parameters, the same ones the
 * JS SDK puts on the dialog it opens (client_id, config_id, response_type,
 * override_default_response_type, extras), plus our own redirect_uri and
 * state. Public identifiers only.
 */
export function signupDialogUrl({ appId, configId, graphVersion, redirectUri, state, mode }) {
  const params = new URLSearchParams({
    client_id: appId,
    config_id: configId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    override_default_response_type: "true",
    extras: JSON.stringify({ setup: {}, featureType: SIGNUP_MODES[signupMode(mode)], sessionInfoVersion: "3" }),
  });
  return `https://www.facebook.com/${graphVersion}/dialog/oauth?${params}`;
}

export function signupStateCookie(state) {
  return `${SIGNUP_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=${SIGNUP_CALLBACK_PATH}; Max-Age=${SIGNUP_STATE_TTL_SECONDS}`;
}

export function clearedSignupStateCookie() {
  return `${SIGNUP_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${SIGNUP_CALLBACK_PATH}; Max-Age=0`;
}
