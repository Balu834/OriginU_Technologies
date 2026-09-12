import { handleLogin } from "../routes/dashboard.mjs";
import { getDeps, readRawBody, sendResult } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = getDeps();
    const rawBody = await readRawBody(req);
    const result = await handleLogin({ headers: req.headers, rawBody }, deps);
    return sendResult(res, result);
  } catch (err) {
    logError("login_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
