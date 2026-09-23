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
    // A machine-readable failure reason, never a credential — the settings
    // page has to be able to say WHY a connection is in ERROR.
    lastError: integration.lastError ?? null,
  };
}

/**
 * The connection state of record.
 *
 * This reads the PERSISTED status field rather than re-deriving anything.
 * State that is recomputed on each render can disagree with what was
 * actually stored, and for this product the stored answer is the only one
 * that means anything: CONNECTED exists solely to record that Meta was
 * asked and said yes.
 */
export function integrationState(integration) {
  if (!integration) return "NOT_CONNECTED";
  return INTEGRATION_STATUSES.includes(integration.status) ? integration.status : "NOT_CONNECTED";
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

    /**
     * Registers an integration, refusing a phone number another business
     * already claims.
     *
     * A business has at most one integration, so re-registering REPLACES
     * it in place rather than inserting a second record. That matters for
     * more than tidiness: the previous version created a fresh row each
     * time, which left the old `integration:phone:<old>` mapping pointing
     * at an abandoned record. The stale mapping meant a number this
     * business no longer used stayed permanently claimed — no other
     * business could ever register it — and an inbound event on it still
     * resolved to a live tenant.
     *
     * The superseded number is released only after the new mapping is
     * written, so a failure mid-way leaves the business reachable on its
     * old number rather than on none at all.
     */
    async register(input) {
      const phoneNumberId = String(input.phoneNumberId ?? "");
      const claimant = await store.getIntegrationByPhoneNumberId?.(phoneNumberId);
      if (claimant && claimant.businessId !== input.businessId) {
        throw new Error(
          `phone_number_id ${maskIdentifier(input.phoneNumberId)} is already registered to another business`
        );
      }

      const previous = await store.getIntegrationByBusiness?.(input.businessId);
      const integration = createIntegration({ ...input, encryptionKey: key });

      // Keep the business's integration identity stable across changes;
      // only the credentials and the number move.
      if (previous && !previous._legacy) {
        integration.id = previous.id;
        integration.createdAt = previous.createdAt;
      }

      await store.saveIntegration(integration);

      if (previous && !previous._legacy && previous.phoneNumberId && previous.phoneNumberId !== phoneNumberId) {
        // Compare-and-delete: this can only drop a mapping that still
        // points at THIS integration, so one business can never release
        // another's number.
        await store.releasePhoneNumberMapping?.(previous.phoneNumberId, previous.id);
      }

      return integration;
    },

    /**
     * Records that Meta confirmed these credentials.
     *
     * Only ever called from a real verification result — nothing in this
     * codebase may call it because a form was submitted. The spread keeps
     * businessId, phoneNumberId and the encrypted credentials exactly as
     * they were: this transition records evidence, it does not edit the
     * integration.
     *
     * A legacy env-backed integration is not stored anywhere, so there is
     * nothing to persist to; it is returned unchanged rather than
     * pretending the transition happened.
     */
    async markVerified(integration, at = new Date().toISOString()) {
      if (!integration || integration._legacy) return integration;
      const updated = {
        ...integration,
        status: "CONNECTED",
        lastVerifiedAt: at,
        lastError: null,
        updatedAt: at,
      };
      await store.saveIntegration(updated);
      return updated;
    },

    /**
     * Records that Meta rejected these credentials.
     *
     * `lastVerifiedAt` is deliberately left untouched: it means "the last
     * time this was actually proven", and a later failure does not unmake
     * a verification that really happened. The status is what changes.
     */
    async markVerificationFailed(integration, reason, at = new Date().toISOString()) {
      if (!integration || integration._legacy) return integration;
      const updated = {
        ...integration,
        status: "ERROR",
        lastError: String(reason ?? "unknown"),
        updatedAt: at,
      };
      await store.saveIntegration(updated);
      return updated;
    },
  };
}
