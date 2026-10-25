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

/**
 * Applies an edit to a business profile.
 *
 * Built by naming the fields a form may change and copying everything
 * else from the existing record, so a crafted post cannot reach `id`,
 * `passwordHash`, `missedCallApiKey`, `createdAt` or any credential. The
 * safe list is the allow-list; there is no deny-list to forget to update
 * when a field is added later.
 *
 * Returns `{ business, errors }`. Nothing is persisted here — the caller
 * decides, and only after checking `errors` is empty.
 */
export function applyBusinessProfile(existing, input = {}, { isValidPhone, normalizePhone } = {}) {
  const errors = {};
  const text = (v) => String(v ?? "").trim();
  const list = (v) =>
    Array.isArray(v) ? v.map(text).filter(Boolean)
      : text(v).split(",").map((s) => s.trim()).filter(Boolean);

  const name = text(input.name);
  if (!name) errors.name = "Business name is required.";
  if (name.length > 120) errors.name = "Business name is too long.";

  // The owner's number is where every lead alert goes, so a typo here is
  // silent lead loss. Validated against the same E.164 rule the WhatsApp
  // send path uses, rather than a looser one that would accept something
  // Meta later rejects.
  const ownerWhatsApp = normalizePhone ? normalizePhone(text(input.ownerWhatsApp)) : text(input.ownerWhatsApp);
  if (!ownerWhatsApp) {
    errors.ownerWhatsApp = "A WhatsApp number for lead alerts is required.";
  } else if (isValidPhone && !isValidPhone(ownerWhatsApp)) {
    errors.ownerWhatsApp = "Enter the number in international format, e.g. +919876543210.";
  }

  // The owner's name fills {{owner_name}} in the missed-call template, and
  // Meta rejects a template sent with an empty parameter, so a business
  // without one cannot send a single missed-call message.
  const ownerName = text(input.ownerName) || existing?.ownerName || "";
  if (!ownerName) errors.ownerName = "Owner name is required. Customers are told this person will call back.";

  const timezone = text(input.timezone) || existing?.timezone || "Asia/Kolkata";
  if (timezone.length > 64) errors.timezone = "That timezone does not look right.";

  const greeting = text(input.greeting);
  if (greeting.length > 500) errors.greeting = "Keep the greeting under 500 characters.";

  const business = {
    ...existing,
    // Only these may move.
    name,
    ownerName,
    ownerWhatsApp,
    industry: text(input.industry),
    businessPhone: text(input.businessPhone),
    timezone,
    greeting,
    services: list(input.services),
    areas: list(input.areas),
    // Explicitly re-pinned from the existing record so that even a future
    // spread mistake above cannot let a form rewrite identity.
    id: existing.id,
    createdAt: existing.createdAt,
    passwordHash: existing.passwordHash,
    missedCallApiKey: existing.missedCallApiKey,
    phoneNumberId: existing.phoneNumberId,
    wabaId: existing.wabaId,
    updatedAt: new Date().toISOString(),
  };

  return { business, errors };
}

/** Safe to render. Never carries the dashboard password hash or the missed-call API key. */
export function publicBusiness(business) {
  if (!business) return null;
  return {
    id: business.id,
    name: business.name ?? "",
    industry: business.industry ?? "",
    businessPhone: business.businessPhone ?? "",
    timezone: business.timezone ?? "",
    ownerName: business.ownerName ?? "",
    ownerWhatsApp: business.ownerWhatsApp ?? "",
    services: [...(business.services ?? [])],
    areas: [...(business.areas ?? [])],
    greeting: business.greeting ?? "",
    updatedAt: business.updatedAt ?? null,
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

  // Start from the environment, overlay the stored record's NON-EMPTY
  // values, then re-assert the fields the environment owns outright.
  //
  // Only non-empty stored values win, so a record saved with blank
  // profile fields cannot wipe the live tenant's name or owner number;
  // and the credential fields are re-applied last, so no write to the
  // store can redirect a working integration.
  const storedDefault = stored.find((b) => b.id === envBusiness.id);
  const merged = storedDefault
    ? { ...envBusiness, ...stripEmpty(storedDefault), ...stripEmpty(pick(envBusiness, ENV_AUTHORITATIVE)) }
    : envBusiness;

  const others = stored.filter((b) => b.id !== envBusiness.id);
  return createBusinessRegistry([merged, ...others]);
}

/**
 * The fields the environment still owns for the `default` business.
 *
 * Deliberately only credentials and routing: the number Meta delivers to,
 * the API key the phone automation authenticates with, the template name,
 * the dashboard password. A bad write to the store must not be able to
 * redirect a working production integration.
 *
 * Profile fields are NOT on this list, and that matters: while the
 * environment overrode everything, saving a new owner WhatsApp number for
 * the live business appeared to succeed and then had no effect, because
 * MOHAMED_WHATSAPP_NUMBER shadowed it on the next read. Editing a profile
 * has to actually change behaviour or it is theatre.
 */
const ENV_AUTHORITATIVE = [
  "phoneNumberId", "wabaId", "missedCallApiKey",
  "missedCallTemplate", "templateLanguage", "passwordHash", "status",
];

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
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
