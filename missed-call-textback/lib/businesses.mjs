/**
 * Tenant resolution.
 *
 * Every inbound event has to be attributed to exactly one business before
 * anything is read or written, because the store namespaces all data by
 * business id. There are two entry points and each carries its own
 * identifier:
 *
 *   inbound WhatsApp  ->  value.metadata.phone_number_id  (Meta tells us
 *                         which of our numbers the customer messaged)
 *   missed call       ->  the bearer API key the phone automation sends
 *
 * Today the registry holds a single business built from environment
 * variables — the deployment serves one contractor. The point of this
 * module is that the *lookup* is the seam: adding a second business means
 * returning more rows here, not touching routing, conversation or storage
 * code. Resolution failure is a hard stop, never a fallback to "the first
 * business", which is how cross-tenant leaks happen.
 */

/** Builds the single env-configured business. */
export function businessFromConfig(config) {
  return {
    id: "default",
    name: config.BUSINESS_NAME,
    ownerName: config.OWNER_NAME,
    ownerWhatsApp: config.MOHAMED_WHATSAPP_NUMBER,
    phoneNumberId: String(config.META_PHONE_NUMBER_ID ?? ""),
    wabaId: config.META_WABA_ID,
    missedCallApiKey: config.MISSED_CALL_API_KEY,
    missedCallTemplate: config.WHATSAPP_MISSED_CALL_TEMPLATE,
    templateLanguage: config.WHATSAPP_TEMPLATE_LANGUAGE,
    status: "active",
  };
}

export function createBusinessRegistry(businesses) {
  const all = businesses.filter((b) => b && b.id);

  return {
    list() {
      return [...all];
    },

    byId(id) {
      return all.find((b) => b.id === id) ?? null;
    },

    /**
     * Resolves the business an inbound WhatsApp message was sent to.
     * Returns null when the number isn't one of ours — the caller must
     * drop the event rather than guess.
     */
    byPhoneNumberId(phoneNumberId) {
      const wanted = String(phoneNumberId ?? "");
      const match = wanted ? all.find((b) => b.phoneNumberId && b.phoneNumberId === wanted) : null;
      if (match) return match;

      // With exactly one business there is no tenant to confuse it with, so
      // an unrecognised or absent id is attributed to it rather than
      // dropped. Strict matching on a single-tenant deployment would turn
      // any surprise in Meta's payload — a renumbered id, a missing
      // metadata block — into silently discarded customer messages. The
      // moment a second business exists this stops applying and a
      // mismatch is a hard drop, because then attribution can be *wrong*
      // rather than merely unconfirmed.
      if (all.length === 1) return { ...all[0], attributionAssumed: true };
      return null;
    },

    /**
     * Resolves the business behind a missed-call API key. Compared in
     * constant time so the endpoint can't be used to discover a valid key
     * one character at a time.
     */
    byApiKey(key, timingSafeEqualStr) {
      if (!key) return null;
      return all.find((b) => b.missedCallApiKey && timingSafeEqualStr(key, b.missedCallApiKey)) ?? null;
    },
  };
}

/** Only what the conversation layer legitimately needs — never keys or tokens. */
export function businessContext(business) {
  return {
    id: business.id,
    name: business.name,
    ownerName: business.ownerName,
    ownerWhatsApp: business.ownerWhatsApp,
  };
}
