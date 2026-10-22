import { handleIvrMissedCall } from "../routes/missedCall.mjs";
import { getRequestDeps, readRawBody } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = await getRequestDeps();
    const rawBody = req.method === "POST" ? await readRawBody(req) : Buffer.alloc(0);
    const query = new URL(req.url, "http://localhost").searchParams;

    const result = await handleIvrMissedCall({ headers: req.headers, query, rawBody }, deps);
    return res.status(result.status).json(result.body);
  } catch (err) {
    logError("ivr_missed_call_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
