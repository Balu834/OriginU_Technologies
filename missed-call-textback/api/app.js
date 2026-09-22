/**
 * Every browser-facing page in one function.
 *
 * Vercel's Hobby plan caps a deployment at 12 serverless functions, and a
 * file-per-route layout exceeded it. The webhook and missed-call
 * endpoints keep their own functions — they are the externally called,
 * reliability-sensitive ones — while the pages share this dispatcher.
 */
import { dispatch, NON_JSON_POSTS } from "../routes/router.mjs";
import { getRequestDeps, readRawBody, sendResult, ctxFromRequest } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const rawBody = req.method === "POST" ? await readRawBody(req) : Buffer.alloc(0);
    const ctx = ctxFromRequest(req, rawBody);

    if (req.method === "POST" && !NON_JSON_POSTS.has(ctx.pathname)) {
      try {
        ctx.json = JSON.parse(rawBody.toString("utf8") || "{}");
      } catch {
        return res.status(400).json({ error: "malformed JSON body" });
      }
    }

    const result = await dispatch(ctx, await getRequestDeps());
    if (!result) return res.status(404).json({ error: "not found" });
    return sendResult(res, result);
  } catch (err) {
    logError("app_handler_error", err, { path: req.url });
    return res.status(500).json({ error: "internal error" });
  }
}
