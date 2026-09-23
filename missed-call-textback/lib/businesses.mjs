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

/**
 * A business as stored data, rather than environment configuration.
 *
 * Profile, services, areas and greeting live here so a business can be
 * configured at runtime instead of by redeploying. Meta credentials
 * deliberately do NOT: they stay in the environment, server-side only,
 * which is also why this remains single-business for WhatsApp until each
 * tenant can hold its own credentials in a secret store.
 */
export function businessRecord({
  id,
  name = "",
  industry = "",
  businessPhone = "",
  timezone = "Asia/Kolkata",
  ownerName = "",
  ownerWhatsApp = "",
  services = [],
  areas = [],
  greeting = "",
  assistantName = "",
  phoneNumberId = "",
  wabaId = "",
  missedCallApiKey = "",
  missedCallTemplate = "",
  templateLanguage = "en",
  passwordHash = "",
  status = "active",
  createdAt = null,
  updatedAt = null,
} = {}) {
  const now = new Date().toISOString();
  return {
    id,
    name,
    industry,
    businessPhone,
    timezone,
    ownerName,
    ownerWhatsApp,
    services: [...services],
    areas: [...areas],
    greeting,
    assistantName,
    phoneNumberId: String(phoneNumberId ?? ""),
    wabaId,
    missedCallApiKey,
    missedCallTemplate,
    templateLanguage,
    passwordHash,
    status,
    createdAt: createdAt ?? now,
    updatedAt: updatedAt ?? now,
  };
}

export const CONNECTION_STATES = ["NOT_CONNECTED", "CONFIGURED", "CONNECTED", "ERROR"];

/**
 * WhatsApp connection state, derived from evidence rather than from the
 * presence of configuration.
 *
 * CONFIGURED means the fields exist. CONNECTED means Meta has actually
 * accepted traffic for this number — proven by a recorded successful
 * send, not by someone having filled in a form. Claiming CONNECTED from
 * configuration alone is exactly the lie this project has been bitten by:
 * an accepted API call is not a delivered message, and a filled-in field
 * is not a working integration.
 */
export function connectionState(business, evidence = {}) {
  if (evidence.lastError) return "ERROR";
  const configured = Boolean(business?.phoneNumberId) && Boolean(business?.missedCallTemplate);
  if (!configured) return "NOT_CONNECTED";
  return evidence.lastSuccessfulSendAt ? "CONNECTED" : "CONFIGURED";
}

/**
 * `evidence.connection` is the PERSISTED integration status, and when it
 * is supplied it wins. Deriving the connection from the business record
 * instead was why "WhatsApp connected" could never tick: a self-service
 * business keeps its number on its integration, not on its profile, so the
 * derived answer was permanently NOT_CONNECTED no matter what Meta said.
 */
export function onboardingStatus(business, evidence = {}) {
  const profileComplete = Boolean(business?.name && business?.ownerName && business?.ownerWhatsApp);
  const aiConfigured = Boolean(business?.services?.length || business?.greeting);
  const connection = evidence.connection ?? connectionState(business, evidence);
  return {
    PROFILE_COMPLETE: profileComplete,
    WHATSAPP_CONNECTED: connection === "CONNECTED",
    AI_CONFIGURED: aiConfigured,
    ONBOARDING_COMPLETE: profileComplete && aiConfigured && connection === "CONNECTED",
    connection,
  };
}

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
    // The dashboard credential belongs to the business, not to the
    // deployment. One hash per business is what makes a second tenant's
    // login resolve to a different tenant's data.
    passwordHash: config.DASHBOARD_PASSWORD_HASH,
    status: "active",
    createdAt: config.BUSINESS_CREATED_AT ?? null,
  };
}

/**
 * Builds the registry from stored businesses plus the env-configured one.
 *
 * The env business always wins for its own id. That is deliberate: the
 * live `default` tenant's Meta credentials and phone number come from the
 * environment, and a stored record must never be able to shadow them —
 * otherwise a bad write to the store could silently redirect a working
 * production integration.
 *
 * Stored businesses supply everything the environment can't: profile,
 * services, areas, greeting. For `default` those are merged in underneath
 * the env values, so it can be configured at runtime without putting its
 * credentials in the database.
 */
export async function loadBusinessRegistry(store, config) {
  const envBusiness = businessFromConfig(config);
  let stored = [];
  try {
    stored = (await store.listBusinesses?.()) ?? [];
  } catch {
    stored = []; // a store failure must not take the live tenant offline
  }

  const storedDefault = stored.find((b) => b.id === envBusiness.id);
  const merged = storedDefault
    ? { ...storedDefault, ...stripEmpty(envBusiness) }
    : envBusiness;

  const others = stored.filter((b) => b.id !== envBusiness.id);
  return createBusinessRegistry([merged, ...others]);
}

/** Env values only override where they actually have a value. */
function stripEmpty(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== "" && v !== null && v !== undefined)
  );
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

    /**
     * Resolves which business a dashboard password belongs to.
     *
     * Every candidate is checked rather than returning on the first hit,
     * so the work done — and therefore the time taken — doesn't depend on
     * which business matched or how far down the list it sits.
     *
     * Scaling note: with no user model there is no username to look the
     * business up by, so this is O(businesses) scrypt verifications per
     * login attempt. Fine for a handful of tenants; a real user/identity
     * model is required before this is the login path for many.
     */
    byPassword(password, verifyPassword) {
      if (!password) return null;
      let found = null;
      for (const b of all) {
        if (b.passwordHash && verifyPassword(password, b.passwordHash)) found ??= b;
      }
      return found;
    },
  };
}

/**
 * Safety rules that belong to the product, not to any business.
 *
 * These are returned as a frozen object and merged AFTER business
 * configuration, so a tenant cannot switch them off by putting contrary
 * text in their greeting or services. A business configures what it does;
 * it does not get to configure whether the assistant may diagnose a
 * live electrical fault.
 */
export const SAFETY_RULES = Object.freeze({
  neverDiagnose: true,
  neverQuotePrices: true,
  neverPromiseAppointments: true,
  emergencyGuidanceOnly: true,
});

/**
 * Everything the conversation layer legitimately needs about a business —
 * and nothing else. Credentials are structurally absent rather than
 * filtered out, so a future field added to the record can't leak here by
 * being forgotten.
 */
export function businessContext(business) {
  return {
    id: business.id,
    name: business.name,
    ownerName: business.ownerName,
    ownerWhatsApp: business.ownerWhatsApp,
    industry: business.industry ?? "",
    services: [...(business.services ?? [])],
    areas: [...(business.areas ?? [])],
    greeting: business.greeting ?? "",
    assistantName: business.assistantName ?? "",
    timezone: business.timezone ?? "Asia/Kolkata",
    safety: SAFETY_RULES,
  };
}
