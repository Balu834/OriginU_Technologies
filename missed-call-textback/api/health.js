import { handleHealth } from "../routes/health.mjs";

export default function handler(req, res) {
  const result = handleHealth();
  return res.status(result.status).json(result.body);
}
