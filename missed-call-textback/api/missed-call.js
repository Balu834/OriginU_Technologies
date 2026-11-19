import { handleMissedCall } from "../routes/missedCall.mjs";
import { getRequestDeps, readRawBody } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = await getRequestDeps();
    const rawBody = await readRawBody(req);
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    // A body that is not JSON is not refused here: it was typed on a phone
    // keyboard, and the handler reads it as form fields or fixes its quotes
    // (and logs what arrived if it still has no caller number).
    let json = null;
    try {
      json = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      json = null;
    }

    const result = await handleMissedCall({ headers: req.headers, query, rawBody, json }, deps);
    return res.status(result.status).json(result.body);
  } catch (err) {
    logError("missed_call_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
