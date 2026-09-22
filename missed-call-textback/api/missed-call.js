import { handleMissedCall } from "../routes/missedCall.mjs";
import { getRequestDeps, readRawBody } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = await getRequestDeps();
    const rawBody = await readRawBody(req);
    let json;
    try {
      json = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      return res.status(400).json({ error: "malformed JSON body" });
    }

    const result = await handleMissedCall({ headers: req.headers, json }, deps);
    return res.status(result.status).json(result.body);
  } catch (err) {
    logError("missed_call_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
