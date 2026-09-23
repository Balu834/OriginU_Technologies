/**
 * Proving that a business's WhatsApp credentials actually work.
 *
 * Until now the only Meta operation this application performed was sending
 * a message (POST /{phone_number_id}/messages). That is authoritative, but
 * it is not usable as a check at credential-submission time: verifying by
 * sending means messaging a real person to find out whether a form was
 * filled in correctly.
 *
 * So this adds the read-only equivalent. Two Graph calls, both of which
 * Meta answers authoritatively:
 *
 *   GET /{phone_number_id}          does this token authenticate, and does
 *                                   it have access to this number?
 *   GET /{waba_id}/phone_numbers    does this number actually belong to
 *                                   the WABA the business claims?
 *
 * The second call is the one that matters for tenancy. Without it a
 * business could enter any phone_number_id its token happens to reach and
 * we would call it verified.
 *
 * WHAT THIS PROVES, precisely: the credentials authenticate, the number is
 * reachable under them, it belongs to the declared WABA, and Meta itself
 * reports the number CONNECTED to the Cloud API.
 *
 * WHAT IT DOES NOT PROVE: that any particular message will be delivered.
 * Recipient allowlists on test numbers, the 24-hour session window and
 * per-WABA template approval are all still free to reject an individual
 * send. CONNECTED here means "this integration is wired up correctly", not
 * "every message will arrive" — and nothing in this codebase may use it to
 * claim the latter.
 */
import { logError } from "./logger.mjs";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 8000;
const MAX_PHONE_PAGES = 10;

/**
 * Why a verification failed, as a stable machine-readable reason. The UI
 * maps these to sentences; nothing here is a secret.
 */
export const FAILURE_REASONS = {
  MISSING_CREDENTIALS: "missing_credentials",
  INVALID_CREDENTIALS: "invalid_credentials",
  NUMBER_NOT_ACCESSIBLE: "number_not_accessible",
  IDENTITY_MISMATCH: "identity_mismatch",
  WABA_NOT_CONFIGURED: "waba_not_configured",
  WABA_CHECK_FAILED: "waba_check_failed",
  WABA_MISMATCH: "waba_mismatch",
  NOT_CLOUD_API: "not_cloud_api",
  NUMBER_NOT_CONNECTED: "number_not_connected",
  NETWORK_ERROR: "network_error",
};

export const VERIFIED_MESSAGE =
  "Meta confirmed this number, on this WhatsApp Business Account, with these credentials.";

const MESSAGES = {
  [FAILURE_REASONS.MISSING_CREDENTIALS]: "A phone number ID and access token are both required.",
  [FAILURE_REASONS.INVALID_CREDENTIALS]: "Meta rejected that access token.",
  [FAILURE_REASONS.NUMBER_NOT_ACCESSIBLE]: "That token cannot reach that phone number ID.",
  [FAILURE_REASONS.IDENTITY_MISMATCH]: "Meta returned a different phone number ID than the one submitted.",
  [FAILURE_REASONS.WABA_NOT_CONFIGURED]: "A WhatsApp Business Account ID is required before the connection can be verified.",
  [FAILURE_REASONS.WABA_CHECK_FAILED]: "Meta would not confirm which WhatsApp Business Account owns that number.",
  [FAILURE_REASONS.WABA_MISMATCH]: "That phone number does not belong to the WhatsApp Business Account given.",
  [FAILURE_REASONS.NOT_CLOUD_API]: "That number is not set up on the WhatsApp Cloud API.",
  [FAILURE_REASONS.NUMBER_NOT_CONNECTED]: "Meta reports that number is not connected yet.",
  [FAILURE_REASONS.NETWORK_ERROR]: "Could not reach Meta to verify the connection.",
};

/** The same sentences, for a route rendering a ?v=<reason> marker. */
export const FAILURE_MESSAGES = MESSAGES;

const failure = (reason, meta = null) => ({
  ok: false,
  reason,
  message: MESSAGES[reason] ?? "Verification failed.",
  meta,
  details: null,
});

/** Meta's error envelope, reduced to the parts that are safe to keep and useful to read. */
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

export function createMetaVerifier({ fetchImpl = fetch, graphBase = GRAPH_BASE } = {}) {
  async function get(path, accessToken) {
    const res = await fetchImpl(`${graphBase}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  return {
    /**
     * Returns { ok, reason, message, meta, details }. Never returns, logs
     * or echoes the access token — only Meta's own error code and message,
     * which are API metadata rather than credentials.
     */
    async verify({ phoneNumberId, wabaId, accessToken } = {}) {
      const id = String(phoneNumberId ?? "").trim();
      const waba = String(wabaId ?? "").trim();
      const token = String(accessToken ?? "").trim();

      if (!id || !token) return failure(FAILURE_REASONS.MISSING_CREDENTIALS);
      // Ownership cannot be proven against a WABA that was never given, and
      // an unprovable claim must not become CONNECTED.
      if (!waba) return failure(FAILURE_REASONS.WABA_NOT_CONFIGURED);

      let number;
      try {
        number = await get(
          `/${encodeURIComponent(id)}?fields=id,display_phone_number,verified_name,quality_rating,platform_type,status`,
          token
        );
      } catch (err) {
        logError("meta_verify_unreachable", err, { step: "phone_number" });
        return failure(FAILURE_REASONS.NETWORK_ERROR);
      }

      if (!number.ok) {
        const meta = metaError(number.body);
        // 190 is Meta's "bad/expired token"; anything else at this point is
        // the token being unable to see this particular number.
        const reason = meta?.code === 190
          ? FAILURE_REASONS.INVALID_CREDENTIALS
          : FAILURE_REASONS.NUMBER_NOT_ACCESSIBLE;
        return failure(reason, meta);
      }

      if (String(number.body?.id ?? "") !== id) {
        return failure(FAILURE_REASONS.IDENTITY_MISMATCH);
      }

      const platformType = number.body?.platform_type ?? null;
      const numberStatus = number.body?.status ?? null;

      let owned;
      try {
        owned = await listWabaNumbers(waba, token);
      } catch (err) {
        logError("meta_verify_unreachable", err, { step: "waba_phone_numbers" });
        return failure(FAILURE_REASONS.NETWORK_ERROR);
      }
      if (!owned.ok) return failure(FAILURE_REASONS.WABA_CHECK_FAILED, owned.meta);
      if (!owned.ids.includes(id)) return failure(FAILURE_REASONS.WABA_MISMATCH);

      if (platformType !== "CLOUD_API") return failure(FAILURE_REASONS.NOT_CLOUD_API);
      if (numberStatus !== "CONNECTED") return failure(FAILURE_REASONS.NUMBER_NOT_CONNECTED);

      return {
        ok: true,
        reason: null,
        message: "Meta confirmed this number, on this WhatsApp Business Account, with these credentials.",
        meta: null,
        details: {
          displayPhoneNumber: number.body?.display_phone_number ?? "",
          verifiedName: number.body?.verified_name ?? "",
          qualityRating: number.body?.quality_rating ?? null,
          platformType,
          numberStatus,
        },
      };
    },
  };

  /** Every phone number id on a WABA, following Meta's paging. */
  async function listWabaNumbers(wabaId, accessToken) {
    const ids = [];
    let path = `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`;

    for (let page = 0; page < MAX_PHONE_PAGES && path; page++) {
      const res = await get(path, accessToken);
      if (!res.ok) return { ok: false, ids, meta: metaError(res.body) };

      for (const entry of res.body?.data ?? []) {
        if (entry?.id) ids.push(String(entry.id));
      }

      const next = res.body?.paging?.next;
      // Meta returns an absolute URL; reduce it back to a path this client
      // can issue, and stop rather than follow anything off-host.
      path = null;
      if (typeof next === "string" && next.startsWith(`${graphBase}/`)) {
        path = next.slice(graphBase.length);
      }
    }

    return { ok: true, ids, meta: null };
  }
}
