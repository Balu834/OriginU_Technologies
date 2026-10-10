/**
 * Meta's WhatsApp Embedded Signup — the server half.
 *
 * WHAT THIS IS. Embedded Signup is Meta's own onboarding flow for business
 * customers: Facebook Login for Business opens in a popup, the customer
 * signs in with their own Meta account, picks (or creates) their WhatsApp
 * Business Account and phone number, and Meta hands the *spawning window*
 * two things — the asset ids (`waba_id`, `phone_number_id`) over
 * postMessage, and a short-lived exchangeable authorization code in the
 * `FB.login` callback. The browser forwards all three to this server and
 * the customer never sees, types or holds a credential.
 *
 * WHY IT IS BUILT THIS WAY. There is no redirect-based OAuth endpoint for
 * this flow and one must not be invented: the code arrives in JavaScript,
 * not on a callback URL. That has one useful security consequence — no
 * credential ever travels in a query string, because there is no redirect
 * to put one in. The code is POSTed, over HTTPS, on a same-site session.
 *
 * WHAT THIS MODULE MAY NOT DO. It never returns a token to a caller that
 * renders HTML, never logs one, and never puts one in an error. Meta's own
 * error code and message are API metadata and are kept for the log; the
 * sentences shown to a customer come from SIGNUP_MESSAGES below, so a raw
 * Graph error can't reach a business owner's screen.
 *
 * The exchanged token is a customer-scoped business token: it can reach
 * that customer's WABA and no one else's. It is handed straight to the
 * integration service, which encrypts it before it is stored.
 */
import { log, logError } from "./logger.mjs";

/**
 * The Graph version this flow speaks.
 *
 * Deliberately separate from the v21.0 the message-sending and verifier
 * modules pin: those are working paths with their own tests, and bumping
 * them for an unrelated feature would put a live send path at risk.
 * Embedded Signup v4 is newer than both, so it gets its own version, and
 * `META_GRAPH_VERSION` exists so it can be bumped without a deploy of new
 * code when Meta retires one.
 */
export const DEFAULT_GRAPH_VERSION = "v23.0";

const TIMEOUT_MS = 10000;

/** Stable machine-readable reasons. None of these is or contains a secret. */
export const SIGNUP_FAILURES = {
  NOT_CONFIGURED: "signup_not_configured",
  MISSING_CODE: "signup_missing_code",
  MISSING_ASSETS: "signup_missing_assets",
  EXCHANGE_FAILED: "signup_exchange_failed",
  NETWORK_ERROR: "signup_network_error",
  NUMBER_TAKEN: "signup_number_taken",
  CANCELLED: "signup_cancelled",
};

/**
 * What a business owner is told. Written for someone who has never heard
 * of a phone number id, and deliberately never interpolates a Meta error.
 */
export const SIGNUP_MESSAGES = {
  [SIGNUP_FAILURES.NOT_CONFIGURED]:
    "WhatsApp connection isn't available yet. Use Advanced Setup, or contact support.",
  [SIGNUP_FAILURES.MISSING_CODE]:
    "WhatsApp connection wasn't completed. You can try again or use Advanced Setup.",
  [SIGNUP_FAILURES.MISSING_ASSETS]:
    "We couldn't find a WhatsApp Business number for this account. Finish creating your WhatsApp Business account with Meta, then try again.",
  [SIGNUP_FAILURES.EXCHANGE_FAILED]:
    "Meta didn't complete the connection. You can try again or use Advanced Setup.",
  [SIGNUP_FAILURES.NETWORK_ERROR]:
    "We couldn't reach Meta just then. Try again in a moment.",
  [SIGNUP_FAILURES.NUMBER_TAKEN]:
    "That WhatsApp number is already connected to another account here. Contact support if it should be yours.",
  [SIGNUP_FAILURES.CANCELLED]:
    "WhatsApp connection wasn't completed. You can try again or use Advanced Setup.",
};

/** The friendly sentence for a failure marker, whatever its source. */
export function signupMessage(code) {
  return SIGNUP_MESSAGES[code] ?? SIGNUP_MESSAGES[SIGNUP_FAILURES.MISSING_CODE];
}

/**
 * What the browser needs to launch the flow, and whether it can be
 * launched at all.
 *
 * `available` is the honest answer to "can this button do anything?".
 * When it is false the page says so and offers Advanced Setup instead of
 * rendering a button that would open an empty popup — a button that looks
 * real and does nothing is worse than no button.
 *
 * Only the two PUBLIC identifiers are exposed here. The app secret is read
 * by the client below and never leaves the server.
 */
export function embeddedSignupConfig(config = {}) {
  const appId = String(config.META_APP_ID ?? "").trim();
  const configId = String(config.META_EMBEDDED_SIGNUP_CONFIG_ID ?? "").trim();
  const appSecret = String(config.META_APP_SECRET ?? "").trim();
  return {
    appId,
    configId,
    graphVersion: String(config.META_GRAPH_VERSION ?? "").trim() || DEFAULT_GRAPH_VERSION,
    // The secret is required for the code exchange, so a deployment
    // missing it cannot complete a connection and must not offer to.
    available: Boolean(appId && configId && appSecret),
  };
}

/**
 * The templates this platform can create in a customer's WABA, keyed by
 * template name. The wording matches templates.json, which is the copy a
 * human submits by hand; the two must say the same thing because whichever
 * one Meta approved is what the customer's callers receive.
 */
export const TEMPLATE_DEFINITIONS = {
  missed_call_immediate: {
    category: "UTILITY",
    body:
      "Sorry we missed your call — this is {{business_name}}. Reply here with what you need and your area, and {{owner_name}} will call you straight back.",
    example: { business_name: "City Electricals", owner_name: "Ravi" },
  },
  missed_call_after_hours: {
    category: "UTILITY",
    body:
      "Sorry we missed your call — this is {{business_name}}. We're closed right now but reply with what you need and your area, and {{owner_name}} will call you first thing.",
    example: { business_name: "City Electricals", owner_name: "Ravi" },
  },
};

/** Meta's "a template with this name/language already exists" subcodes. */
const TEMPLATE_EXISTS_SUBCODES = new Set([2388023, 2388024]);

/** Seconds until expiry as Meta reports it, or null for a non-expiring token. */
function expiresInOf(body) {
  const n = Number(body?.expires_in);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Meta's error envelope, reduced to what is safe to keep and useful to read. */
function metaError(body) {
  const err = body?.error;
  if (!err) return null;
  return {
    code: err.code ?? null,
    subcode: err.error_subcode ?? null,
    message: err.message ?? null,
    traceId: err.fbtrace_id ?? null,
  };
}

export function createEmbeddedSignupClient({
  appId,
  appSecret,
  graphVersion = DEFAULT_GRAPH_VERSION,
  registerPin = "",
  fetchImpl = fetch,
} = {}) {
  const base = `https://graph.facebook.com/${graphVersion}`;

  async function call(path, { method = "GET", accessToken = null, body = null } = {}) {
    const headers = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: parsed };
  }

  return {
    /**
     * Trades the authorization code for a customer-scoped business token.
     *
     * This is the standard Facebook Login for Business code exchange. No
     * `redirect_uri` is sent, and that is not an omission: the code came
     * from `FB.login`, not from a redirect, so there is no URI to confirm
     * and sending one is rejected.
     *
     * The code's time-to-live is measured in seconds, which is why the
     * browser posts it the moment it arrives rather than holding it.
     */
    async exchangeCode(code) {
      const value = String(code ?? "").trim();
      if (!value) return { ok: false, reason: SIGNUP_FAILURES.MISSING_CODE };

      const params = new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        code: value,
      });

      let res;
      try {
        res = await call(`/oauth/access_token?${params}`);
      } catch (err) {
        logError("embedded_signup_unreachable", err, { step: "exchange" });
        return { ok: false, reason: SIGNUP_FAILURES.NETWORK_ERROR };
      }

      const token = res.body?.access_token;
      if (!res.ok || !token) {
        // Meta's code and message, never the code we sent and never a token.
        const meta = metaError(res.body);
        logError("embedded_signup_exchange_failed", new Error(`status ${res.status}`), {
          status: res.status,
          metaCode: meta?.code ?? null,
          metaMessage: meta?.message ?? null,
        });
        return { ok: false, reason: SIGNUP_FAILURES.EXCHANGE_FAILED, meta };
      }

      return { ok: true, accessToken: String(token), expiresIn: expiresInOf(res.body) };
    },

    /**
     * Trades a still-valid token for a fresh 60-day one.
     *
     * The Embedded Signup configuration Meta offers this app issues tokens
     * that expire after 60 days. Left alone, every customer's connection
     * would silently die two months after they connected. Meta lets a
     * business token be exchanged for a new one while the old one is still
     * valid, so callers refresh ahead of the expiry (see
     * `tokenNeedsRefresh`). An EXPIRED token cannot be refreshed — the
     * customer has to press Connect WhatsApp again.
     */
    async refreshToken(accessToken) {
      const value = String(accessToken ?? "").trim();
      if (!value) return { ok: false, reason: SIGNUP_FAILURES.MISSING_CODE };

      const params = new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        set_token_expires_in_60_days: "true",
        fb_exchange_token: value,
      });

      let res;
      try {
        res = await call(`/oauth/access_token?${params}`);
      } catch (err) {
        logError("embedded_signup_unreachable", err, { step: "refresh" });
        return { ok: false, reason: SIGNUP_FAILURES.NETWORK_ERROR };
      }

      const token = res.body?.access_token;
      if (!res.ok || !token) {
        const meta = metaError(res.body);
        log("embedded_signup_refresh_failed", {
          status: res.status,
          metaCode: meta?.code ?? null,
          metaMessage: meta?.message ?? null,
        });
        return { ok: false, reason: SIGNUP_FAILURES.EXCHANGE_FAILED, meta };
      }
      return { ok: true, accessToken: String(token), expiresIn: expiresInOf(res.body) };
    },

    /**
     * Makes sure the customer's WABA has the missed-call template.
     *
     * A missed call does not open a 24-hour window, so the first message
     * must be a template that exists AND is approved in the customer's own
     * WhatsApp Business Account — this platform's copy is no use to them.
     * Without this step a freshly connected customer shows "Connected" and
     * then fails every single send.
     *
     * Creating it only SUBMITS it; Meta approves utility templates in
     * minutes to a day. "Already exists" is success. Best-effort like the
     * steps beside it: a failure is reported, never allowed to discard a
     * good connection, and can be retried by reconnecting.
     */
    async ensureTemplate(wabaId, accessToken, { name, language = "en" } = {}) {
      const id = String(wabaId ?? "").trim();
      const definition = TEMPLATE_DEFINITIONS[name];
      if (!id) return { ok: false, reason: SIGNUP_FAILURES.MISSING_ASSETS };
      // Only templates this codebase knows the wording of. A custom name
      // set per deployment is that deployment's to create by hand.
      if (!definition) return { ok: false, skipped: true };

      try {
        const res = await call(`/${encodeURIComponent(id)}/message_templates`, {
          method: "POST",
          accessToken,
          body: {
            name,
            language,
            category: definition.category,
            parameter_format: "NAMED",
            components: [
              {
                type: "BODY",
                text: definition.body,
                example: {
                  body_text_named_params: Object.entries(definition.example).map(
                    ([param_name, example]) => ({ param_name, example })
                  ),
                },
              },
            ],
          },
        });
        if (res.ok) return { ok: true, status: String(res.body?.status ?? "PENDING") };

        const meta = metaError(res.body);
        if (TEMPLATE_EXISTS_SUBCODES.has(Number(meta?.subcode)) || /already exists/i.test(meta?.message ?? "")) {
          return { ok: true, existing: true };
        }
        log("embedded_signup_template_failed", {
          metaCode: meta?.code ?? null,
          metaSubcode: meta?.subcode ?? null,
          metaMessage: meta?.message ?? null,
        });
        return { ok: false, meta };
      } catch (err) {
        logError("embedded_signup_unreachable", err, { step: "template" });
        return { ok: false, reason: SIGNUP_FAILURES.NETWORK_ERROR };
      }
    },

    /**
     * Subscribes this app to webhooks on the customer's WABA.
     *
     * Without it Meta has no reason to deliver that customer's inbound
     * messages to us at all. Best-effort by design: a failure here is
     * reported and logged, but it does not throw away a connection that
     * is otherwise good, because it can be retried from the settings page.
     */
    async subscribeApp(wabaId, accessToken) {
      const id = String(wabaId ?? "").trim();
      if (!id) return { ok: false, reason: SIGNUP_FAILURES.MISSING_ASSETS };
      try {
        const res = await call(`/${encodeURIComponent(id)}/subscribed_apps`, {
          method: "POST",
          accessToken,
        });
        if (!res.ok) {
          const meta = metaError(res.body);
          log("embedded_signup_subscribe_failed", {
            metaCode: meta?.code ?? null,
            metaMessage: meta?.message ?? null,
          });
          return { ok: false, meta };
        }
        return { ok: true };
      } catch (err) {
        logError("embedded_signup_unreachable", err, { step: "subscribe" });
        return { ok: false, reason: SIGNUP_FAILURES.NETWORK_ERROR };
      }
    },

    /**
     * Registers the number for Cloud API use.
     *
     * Registration sets the number's two-step verification PIN, so it is
     * attempted only when a PIN has actually been configured for this
     * deployment. With none set this SKIPS rather than inventing a PIN
     * nobody could ever produce again — and says it skipped, so the
     * connection is not reported as more complete than it is. Verification
     * afterwards is what decides whether the number really is usable.
     */
    async registerNumber(phoneNumberId, accessToken) {
      const pin = String(registerPin ?? "").trim();
      if (!pin) return { ok: false, skipped: true };
      const id = String(phoneNumberId ?? "").trim();
      if (!id) return { ok: false, reason: SIGNUP_FAILURES.MISSING_ASSETS };

      try {
        const res = await call(`/${encodeURIComponent(id)}/register`, {
          method: "POST",
          accessToken,
          body: { messaging_product: "whatsapp", pin },
        });
        if (!res.ok) {
          const meta = metaError(res.body);
          // An already-registered number reports a failure here and is
          // fine; verification is the authority on whether it works.
          log("embedded_signup_register_failed", {
            metaCode: meta?.code ?? null,
            metaMessage: meta?.message ?? null,
          });
          return { ok: false, meta };
        }
        return { ok: true };
      } catch (err) {
        logError("embedded_signup_unreachable", err, { step: "register" });
        return { ok: false, reason: SIGNUP_FAILURES.NETWORK_ERROR };
      }
    },

    /**
     * The number as Meta displays it, for the success screen.
     *
     * Cosmetic only — a failure costs a nicely formatted number, nothing
     * more, so it returns empty strings rather than failing a connection.
     */
    async describeNumber(phoneNumberId, accessToken) {
      const id = String(phoneNumberId ?? "").trim();
      if (!id) return { displayPhoneNumber: "", verifiedName: "" };
      try {
        const res = await call(
          `/${encodeURIComponent(id)}?fields=display_phone_number,verified_name`,
          { accessToken }
        );
        if (!res.ok) return { displayPhoneNumber: "", verifiedName: "" };
        return {
          displayPhoneNumber: String(res.body?.display_phone_number ?? ""),
          verifiedName: String(res.body?.verified_name ?? ""),
        };
      } catch {
        return { displayPhoneNumber: "", verifiedName: "" };
      }
    },
  };
}
