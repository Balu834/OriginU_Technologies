/**
 * Request signing between the app and the QR gateway.
 *
 * The gateway holds live WhatsApp sessions for real business numbers, and
 * the app tells it what to send. Either side accepting an unsigned request
 * would let anyone on the internet send WhatsApp messages from a customer's
 * number, so every request in both directions carries an HMAC of its body.
 *
 * Header: `x-missedcall-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`,
 * where the HMAC covers `${t}.${rawBody}` under QR_GATEWAY_SECRET. The
 * timestamp is inside the signed bytes, so an old request cannot be
 * replayed after the tolerance window by changing it.
 *
 * Shared by the app (lib/, routes/) and the gateway (qr-gateway/), so both
 * sides check exactly the same thing.
 */
import crypto from "node:crypto";

export const QR_SIGNATURE_HEADER = "x-missedcall-signature";
const TOLERANCE_SECONDS = 5 * 60;

function hmac(secret, t, body) {
  return crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

/** Signs a request body (string or Buffer). */
export function signQrRequest(body, secret, nowMs = Date.now()) {
  if (!secret) throw new Error("QR_GATEWAY_SECRET is not set");
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${hmac(secret, t, Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? ""))}`;
}

/** True only for a correctly signed, recent request. Constant-time compare. */
export function verifyQrRequest(rawBody, header, secret, nowMs = Date.now()) {
  if (!secret || typeof header !== "string") return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : ["", ""];
    })
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_SECONDS) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
  const expected = Buffer.from(hmac(secret, t, body), "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
