/**
 * Its own serverless function, like the Meta webhook and for the same
 * reason: it is called by an external system, it must read the RAW body
 * to verify a signature, and it should not share a cold start or a
 * failure mode with the browser-facing pages.
 */
import { handleRazorpayWebhook } from "../routes/razorpayWebhook.mjs";
import { getRequestDeps, readRawBody, sendResult } from "./_deps.mjs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }
  const rawBody = await readRawBody(req);
  const deps = await getRequestDeps();
  const result = await handleRazorpayWebhook({ rawBody, headers: req.headers }, deps);
  return sendResult(res, result);
}
