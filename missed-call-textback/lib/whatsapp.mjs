import crypto from "node:crypto";
import { logError } from "./logger.mjs";

export function createWhatsAppClient(config, { fetchImpl = fetch } = {}) {
  const base = `https://graph.facebook.com/v21.0/${config.META_PHONE_NUMBER_ID}/messages`;

  async function send(payload) {
    try {
      const res = await fetchImpl(base, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Meta's own error code is the only thing that distinguishes, say,
        // "recipient not in allowed list" (131030) from "outside the 24h
        // window" (131047). Logging just the HTTP status makes every
        // failure look identical and forces a manual API call to diagnose.
        // Codes and messages are API metadata, not secrets or customer data.
        logError("meta_api_error", new Error(`status ${res.status}`), {
          status: res.status,
          metaCode: body?.error?.code ?? null,
          metaSubcode: body?.error?.error_subcode ?? null,
          metaMessage: body?.error?.message ?? null,
          metaTrace: body?.error?.fbtrace_id ?? null,
        });
      }
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      logError("meta_api_error", err, {});
      return { ok: false, status: 0, body: null };
    }
  }

  return {
    /**
     * `bodyParams` is a { variableName: value } object matching the
     * template's named variables in WhatsApp Manager (e.g.
     * { business_name: "Planet Electrical", owner_name: "Mohamed" }) —
     * Meta's newer templates require each parameter to declare which
     * named variable it fills via `parameter_name`, positional {{1}}/{{2}}
     * substitution alone is no longer accepted for templates created with
     * named variables.
     */
    sendTemplate(to, templateName, languageCode, bodyParams = {}) {
      const entries = Object.entries(bodyParams);
      return send({
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components: entries.length
            ? [
                {
                  type: "body",
                  parameters: entries.map(([parameter_name, text]) => ({
                    type: "text",
                    parameter_name,
                    text,
                  })),
                },
              ]
            : [],
        },
      });
    },
    sendText(to, body) {
      return send({ to, type: "text", text: { body, preview_url: false } });
    },
  };
}

/** Verifies Meta's X-Hub-Signature-256 header against the raw request body using constant-time comparison. */
export function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}
