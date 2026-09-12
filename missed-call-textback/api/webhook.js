import { verifyWebhookGet, handleWebhookPost } from "../routes/webhook.mjs";
import { getDeps, readRawBody } from "./_deps.mjs";
import { logError } from "../lib/logger.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const deps = getDeps();

    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const result = verifyWebhookGet({ query: url.searchParams }, deps);
      if (result.rawText !== undefined) return res.status(result.status).send(result.rawText);
      return res.status(result.status).json(result.body);
    }

    if (req.method === "POST") {
      const rawBody = await readRawBody(req);
      const result = handleWebhookPost({ rawBody, headers: req.headers }, deps);
      // No fire-and-forget here: a serverless function can be frozen the
      // instant a response is sent, so the work has to finish first. Our
      // processing is a couple of WhatsApp API calls — well within Meta's
      // webhook timeout tolerance.
      if (result.afterAck) await result.afterAck();
      return res.status(result.status).json(result.body ?? {});
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    logError("webhook_handler_error", err, {});
    return res.status(500).json({ error: "internal error" });
  }
}
