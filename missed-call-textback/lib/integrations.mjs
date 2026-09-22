/**
 * Per-business WhatsApp integrations.
 *
 * This is the only place Meta credentials are held, decrypted or handed
 * out. Everything else — sending, webhook verification, signature
 * checking — asks this module for a business's integration rather than
 * reading global environment variables, so there is one place to audit
 * rather than four.
 *
 * Two rules the rest of the system depends on:
 *
 * 1. `phoneNumberId` is unique across businesses. Inbound routing keys on
 *    it, so two businesses claiming one number would mean a customer's
 *    message could land in either tenant. Registration refuses it.
 * 2. Decrypted secrets never leave this module except into the Meta HTTP
 *    call itself. `publicView()` is what anything user-facing gets, and
 *    it is built by naming safe fields rather than deleting unsafe ones —
 *    a field added later can't leak by being forgotten.
 */
import crypto from "node:crypto";
import { encryptSecret, decryptSecret, maskIdentifier } from "./crypto.mjs";

export const INTEGRATION_STATUSES = ["NOT_CONNECTED", "CONFIGURED", "CONNECTED", "ERROR"];

export function createIntegration({
  businessId,
  provider = "whatsapp_cloud",
  phoneNumberId,
  wabaId = "",
  displayPhoneNumber = "",
  accessToken = "",
  appSecret = "",
  verifyToken = "",
  status = "CONFIGURED",
  encryptionKey,
}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    businessId,
    provider,
    phoneNumberId: String(phoneNumberId ?? ""),
    wabaId,
    displayPhoneNumber,
    accessTokenEncrypted: encryptSecret(accessToken, encryptionKey),
    appSecretEncrypted: encryptSecret(appSecret, encryptionKey),
    verifyTokenEncrypted: encryptSecret(verifyToken, encryptionKey),
    status,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: null,
  };
}

/**
 * Safe metadata only. Built by listing what may be shown, never by
 * removing what may not.
 */
export function publicView(integration) {
  if (!integration) return null;
  return {
    provider: integration.provider,
    displayPhoneNumber: integration.displayPhoneNumber,
    phoneNumberId: maskIdentifier(integration.phoneNumberId),
    wabaId: maskIdentifier(integration.wabaId),
    status: integration.status,
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
    lastVerifiedAt: integration.lastVerifiedAt,
  };
}

export function createIntegrationService(store, config) {
  const key = config.INTEGRATION_ENCRYPTION_KEY;

  /**
   * MIGRATION-ONLY compatibility path.
   *
   * TODO(remove): delete once the `default` integration is confirmed
   * stored and the global META_* variables are retired from Vercel.
   *
   * Scoped deliberately to the single business named by
   * MIGRATION_DEFAULT_BUSINESS_ID. It is not a general fallback: any
   * other business with no stored integration resolves to null, because
   * silently lending one tenant another's credentials is precisely the
   * failure this whole task exists to prevent.
   */
  function legacyEnvIntegration(businessId) {
    if (businessId !== (config.MIGRATION_DEFAULT_BUSINESS_ID ?? "default")) return null;
    if (!config.META_ACCESS_TOKEN || !config.META_PHONE_NUMBER_ID) return null;
    return {
      id: "legacy-env",
      businessId,
      provider: "whatsapp_cloud",
      phoneNumberId: String(config.META_PHONE_NUMBER_ID),
      wabaId: config.META_WABA_ID ?? "",
      displayPhoneNumber: "",
      status: "CONFIGURED",
      createdAt: null,
      updatedAt: null,
      lastVerifiedAt: null,
      _legacy: true,
      _secrets: {
        accessToken: config.META_ACCESS_TOKEN,
        appSecret: config.META_APP_SECRET,
        verifyToken: config.META_VERIFY_TOKEN,
      },
    };
  }

  /** Decrypts in-memory only; the result never leaves the caller's scope. */
  function secretsOf(integration) {
    if (!integration) return null;
    if (integration._legacy) return integration._secrets;
    return {
      accessToken: decryptSecret(integration.accessTokenEncrypted, key),
      appSecret: decryptSecret(integration.appSecretEncrypted, key),
      verifyToken: decryptSecret(integration.verifyTokenEncrypted, key),
    };
  }

  return {
    async forBusiness(businessId) {
      if (!businessId) return null;
      const stored = await store.getIntegrationByBusiness?.(businessId);
      return stored ?? legacyEnvIntegration(businessId);
    },

    /**
     * Resolves the business a Meta payload belongs to. Returns null for an
     * unknown number — never a default — so an unattributable event is
     * dropped rather than filed under someone else's tenant.
     */
    async byPhoneNumberId(phoneNumberId) {
      const id = String(phoneNumberId ?? "");
      if (!id) return null;
      const stored = await store.getIntegrationByPhoneNumberId?.(id);
      if (stored) return stored;
      const legacy = legacyEnvIntegration(config.MIGRATION_DEFAULT_BUSINESS_ID ?? "default");
      return legacy && legacy.phoneNumberId === id ? legacy : null;
    },

    secretsOf,

    /** Registers an integration, refusing a phone number another business already claims. */
    async register(input) {
      const existing = await store.getIntegrationByPhoneNumberId?.(String(input.phoneNumberId));
      if (existing && existing.businessId !== input.businessId) {
        throw new Error(
          `phone_number_id ${maskIdentifier(input.phoneNumberId)} is already registered to another business`
        );
      }
      const integration = createIntegration({ ...input, encryptionKey: key });
      await store.saveIntegration(integration);
      return integration;
    },

    async markVerified(integration, at = new Date().toISOString()) {
      if (!integration || integration._legacy) return integration;
      const updated = { ...integration, status: "CONNECTED", lastVerifiedAt: at, updatedAt: at };
      await store.saveIntegration(updated);
      return updated;
    },
  };
}
