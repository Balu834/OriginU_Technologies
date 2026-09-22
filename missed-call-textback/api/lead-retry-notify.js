import { handleRetryNotification } from "../routes/dashboard.mjs";
import { getDeps, readRawBody, sendResult, ctxFromRequest } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const raw = await readRawBody(req);
    return sendResult(res, await handleRetryNotification(ctxFromRequest(req, raw), getDeps()));
  } catch (err) {
    logError("retry_notify_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
