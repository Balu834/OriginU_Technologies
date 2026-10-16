/**
 * Transactional email via Resend's REST API (no SDK, no dependency).
 *
 * `configured` is false unless both the API key and a from-address are set,
 * so callers can say "email is unavailable" instead of claiming to have sent.
 * `fetchImpl` is injectable for tests.
 */
export function createMailer(config = {}, fetchImpl = globalThis.fetch) {
  const apiKey = config.RESEND_API_KEY ?? "";
  const from = config.RESET_EMAIL_FROM ?? "";
  const configured = Boolean(apiKey && from);

  return {
    configured,
    /** Resolves true when the provider accepted the message, false otherwise. Never throws. */
    async send({ to, subject, text }) {
      if (!configured) return false;
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
