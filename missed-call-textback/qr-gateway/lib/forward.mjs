/**
 * Sends gateway events (incoming messages, receipts, connection changes)
 * to the MissedCall app at POST <app>/qr/events, signed.
 *
 * Retries network errors and 5xx a couple of times. The app drops a
 * message id it has already processed, so a retry can't double-reply.
 * The app's JSON answer is returned; `{ stop: true }` means "this business
 * should not be on QR any more" and the session manager logs it out.
 */
import { signQrRequest, QR_SIGNATURE_HEADER } from "../../lib/qrSigning.mjs";

export function createForwarder({ appUrl, secret, fetchImpl = fetch, attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = `${String(appUrl).replace(/\/$/, "")}/qr/events`;

  return async function forward(event) {
    const body = JSON.stringify(event);
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      if (i) await sleep(1000 * 3 ** (i - 1));
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", [QR_SIGNATURE_HEADER]: signQrRequest(body, secret) },
          body,
          signal: AbortSignal.timeout(25_000),
        });
        const json = await res.json().catch(() => null);
        if (res.ok) return json ?? {};
        if (res.status < 500 && res.status !== 429) return json ?? {};
        lastError = new Error(`app answered ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error("forward failed");
  };
}
