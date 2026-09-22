import { handleDashboard } from "../routes/dashboard.mjs";
import { getRequestDeps, sendResult, ctxFromRequest } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  try {
    const deps = await getRequestDeps();
    const result = await handleDashboard(ctxFromRequest(req), deps);
    return sendResult(res, result);
  } catch (err) {
    logError("dashboard_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
