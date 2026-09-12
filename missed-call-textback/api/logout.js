import { handleLogout } from "../routes/dashboard.mjs";
import { getDeps, sendResult } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = getDeps();
    const result = await handleLogout({ headers: req.headers }, deps);
    return sendResult(res, result);
  } catch (err) {
    logError("logout_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
