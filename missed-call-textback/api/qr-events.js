/**
 * POST /qr/events — signed events from the QR gateway (UNOFFICIAL route,
 * see lib/qrGateway.mjs). Its own function, like /webhook: it is called by
 * a machine, verifies a signature over the raw body, and should not share
 * a failure mode with the browser pages.
 */
import { handleQrEvent } from "../routes/qrEvents.mjs";
import { getRequestDeps, readRawBody } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const deps = await getRequestDeps();
    const rawBody = await readRawBody(req);
    const result = await handleQrEvent({ rawBody, headers: req.headers }, deps);
    return res.status(result.status).json(result.body ?? {});
  } catch (err) {
    logError("qr_events_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
