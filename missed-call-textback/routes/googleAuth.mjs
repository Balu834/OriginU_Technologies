/**
 * GET /auth/google           — sends the browser to Google's account chooser.
 * GET /auth/google/callback  — Google sends it back here with a code.
 *
 * See lib/googleAuth.mjs for the security model. The callback answers with
 * a tiny page that moves on to the dashboard, not a 302: the session cookie
 * is SameSite=Strict, and a redirect chain that began on accounts.google.com
 * counts as cross-site, so the browser would leave the cookie off the next
 * request and the owner would land back on the sign-in page.
 */
import { createSession, sessionCookie, loginRateLimited, parseCookies } from "../lib/auth.mjs";
import {
  googleAuthConfig, beginGoogleSignIn, consumeGoogleState, googleAuthUrl, stateCookie, clearedStateCookie,
  exchangeGoogleCode, STATE_COOKIE,
} from "../lib/googleAuth.mjs";
import { loginPage, escapeHtml } from "../lib/views.mjs";
import { log } from "../lib/logger.mjs";

function failed(status, error) {
  return { status, headers: { "Set-Cookie": clearedStateCookie() }, html: loginPage({ error, google: true }) };
}

function continuePage(location) {
  const href = escapeHtml(location);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Signing you in</title>
</head><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center">
<p>Signing you in… <a href="${href}">Continue</a></p>
</body></html>`;
}

export async function handleGoogleStart(ctx, deps) {
  const google = googleAuthConfig(deps.config);
  if (!google.available) return { status: 404, html: loginPage({ error: "Google sign-in isn't available right now." }) };
  if (await loginRateLimited(ctx, deps.store)) {
    return { status: 429, html: loginPage({ error: "Too many attempts. Try again later.", google: true }) };
  }

  const { state, nonce } = await beginGoogleSignIn(deps.store);
  return {
    status: 302,
    headers: {
      Location: googleAuthUrl({ clientId: google.clientId, redirectUri: google.redirectUri, state, nonce }),
      "Set-Cookie": stateCookie(state),
    },
    body: {},
  };
}

export async function handleGoogleCallback(ctx, deps) {
  const { store, accounts } = deps;
  const google = googleAuthConfig(deps.config);
  if (!google.available || !accounts) return { status: 404, html: loginPage({ error: "Google sign-in isn't available right now." }) };

  // The owner pressed Cancel on Google's screen.
  if (ctx.query?.get("error")) return failed(200, "Google sign-in was cancelled.");

  const state = ctx.query?.get("state") ?? "";
  const cookieState = parseCookies(ctx.headers?.cookie)[STATE_COOKIE] ?? "";
  const record = state && state === cookieState ? await consumeGoogleState(store, state) : null;
  if (!record) {
    log("google_signin_failed", { reason: "state" });
    return failed(400, "That sign-in attempt expired. Please try again.");
  }

  const identity = await exchangeGoogleCode({
    code: ctx.query?.get("code") ?? "",
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: google.redirectUri,
    nonce: record.nonce,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  if (!identity) {
    log("google_signin_failed", { reason: "token" });
    return failed(400, "We couldn't sign you in with Google. Please try again.");
  }

  const result = await accounts.signInWithGoogle({ email: identity.email, sub: identity.sub });
  if (!result) {
    log("google_signin_failed", { reason: "account" });
    return failed(403, "That email is linked to a different Google account. Sign in with your password instead.");
  }

  const memberships = await accounts.membershipsOf(result.user.id);
  const first = memberships[0] ?? null;
  const sessionId = await createSession(store, first?.businessId ?? null, { userId: result.user.id });
  log("google_signin_succeeded", { created: result.created, hasBusiness: Boolean(first) });

  return {
    status: 200,
    headers: { "Set-Cookie": [sessionCookie(sessionId), clearedStateCookie()] },
    html: continuePage(first ? "/leads" : "/onboarding"),
  };
}
