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
        logError("meta_api_error", new Error(`status ${res.status}`), { status: res.status });
      }
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      logError("meta_api_error", err, {});
      return { ok: false, status: 0, body: null };
    }
  }

  return {
    sendTemplate(to, templateName, languageCode, bodyParams = []) {
      return send({
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components: bodyParams.length
            ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
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
