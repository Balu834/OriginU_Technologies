import { handleLanding } from "../routes/dashboard.mjs";
import { getDeps, sendResult } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = getDeps();
    return sendResult(res, handleLanding({ headers: req.headers }, deps));
  } catch (err) {
    logError("landing_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
