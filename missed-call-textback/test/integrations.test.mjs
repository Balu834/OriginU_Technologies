/**
 * Per-business WhatsApp integrations: encryption, routing, isolation.
 * All credentials here are fixtures — no real secret appears in tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { createIntegrationService, createIntegration, publicView } from "../lib/integrations.mjs";
import { encryptSecret, decryptSecret, generateEncryptionKey, isValidEncryptionKey, maskIdentifier } from "../lib/crypto.mjs";
import { handleWebhookPost } from "../routes/webhook.mjs";
import { createBusinessRegistry } from "../lib/businesses.mjs";
import { createFakeWa, signBody, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const KEY = generateEncryptionKey();

const A_SECRETS = { accessToken: "A-TOKEN-aaa", appSecret: "A-APPSECRET-aaa", verifyToken: "A-VERIFY-aaa" };
const B_SECRETS = { accessToken: "B-TOKEN-bbb", appSecret: "B-APPSECRET-bbb", verifyToken: "B-VERIFY-bbb" };

function svc(store, overrides = {}) {
  return createIntegrationService(store, {
    INTEGRATION_ENCRYPTION_KEY: KEY,
    MIGRATION_DEFAULT_BUSINESS_ID: "default",
    ...overrides,
  });
}

async function twoTenants() {
  const store = createStore(null);
  const integrations = svc(store);
  await integrations.register({ businessId: "acme", phoneNumberId: "111111", wabaId: "WABA-A", ...A_SECRETS });
  await integrations.register({ businessId: "bolt", phoneNumberId: "222222", wabaId: "WABA-B", ...B_SECRETS });
  return { store, integrations };
}

// ---- encryption ----

test("encryption round-trips and produces different ciphertext each time", () => {
  const a = encryptSecret("my-token", KEY);
  const b = encryptSecret("my-token", KEY);
  assert.notEqual(a, b, "a fresh IV must make identical plaintexts look different");
  assert.equal(decryptSecret(a, KEY), "my-token");
  assert.equal(decryptSecret(b, KEY), "my-token");
});

test("stored ciphertext never contains the plaintext", () => {
  const encrypted = encryptSecret("SUPER-SECRET-TOKEN", KEY);
  assert.ok(!encrypted.includes("SUPER-SECRET-TOKEN"));
});

test("a tampered ciphertext fails to decrypt rather than returning altered plaintext", () => {
  const encrypted = encryptSecret("my-token", KEY);
  const [iv, tag, data] = encrypted.split(":");
  const flipped = data.slice(0, -2) + (data.slice(-2) === "00" ? "11" : "00");
  assert.throws(() => decryptSecret(`${iv}:${tag}:${flipped}`, KEY));
});

test("the wrong key cannot decrypt", () => {
  const encrypted = encryptSecret("my-token", KEY);
  assert.throws(() => decryptSecret(encrypted, generateEncryptionKey()));
});

test("a malformed key is rejected outright", () => {
  assert.equal(isValidEncryptionKey("too-short"), false);
  assert.equal(isValidEncryptionKey(KEY), true);
  assert.throws(() => encryptSecret("x", "not-a-key"));
});

// ---- A/C. credential isolation ----

test("A: one business's integration never yields another's credentials", async () => {
  const { integrations } = await twoTenants();
  const acme = await integrations.forBusiness("acme");
  const secrets = integrations.secretsOf(acme);

  assert.equal(secrets.accessToken, A_SECRETS.accessToken);
  assert.notEqual(secrets.accessToken, B_SECRETS.accessToken);
  assert.ok(!JSON.stringify(acme).includes(B_SECRETS.accessToken));
});

test("C: registering a phone number already owned by another business is refused", async () => {
  const { integrations } = await twoTenants();
  await assert.rejects(
    () => integrations.register({ businessId: "acme", phoneNumberId: "222222", ...A_SECRETS }),
    /already registered to another business/
  );
});

test("J: a business may re-register its own phone number", async () => {
  const { integrations } = await twoTenants();
  await assert.doesNotReject(
    () => integrations.register({ businessId: "acme", phoneNumberId: "111111", ...A_SECRETS })
  );
});

// ---- D/E. inbound routing ----

test("E: a known phone_number_id routes to its own business", async () => {
  const { integrations } = await twoTenants();
  assert.equal((await integrations.byPhoneNumberId("222222")).businessId, "bolt");
  assert.equal((await integrations.byPhoneNumberId("111111")).businessId, "acme");
});

test("D: an unknown phone_number_id does NOT fall back to default", async () => {
  const { integrations } = await twoTenants();
  assert.equal(await integrations.byPhoneNumberId("999999"), null);
  assert.equal(await integrations.byPhoneNumberId(""), null);
  assert.equal(await integrations.byPhoneNumberId(undefined), null);
});

test("D: an unattributable webhook creates nothing under any tenant", async () => {
  const { store, integrations } = await twoTenants();
  const deps = {
    store, integrations, templates, wa: createFakeWa(), config: TEST_CONFIG,
    businesses: createBusinessRegistry([
      { id: "acme", name: "Acme", ownerName: "A", ownerWhatsApp: "+911", phoneNumberId: "111111" },
      { id: "bolt", name: "Bolt", ownerName: "B", ownerWhatsApp: "+912", phoneNumberId: "222222" },
    ]),
  };
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "999999" },
      messages: [{ id: "wamid.X", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": signBody(raw) } }, deps).afterAck();

  assert.equal((await scopedToBusiness(store, "acme").listLeads()).length, 0);
  assert.equal((await scopedToBusiness(store, "bolt").listLeads()).length, 0);
  assert.equal(deps.wa.sent.length, 0);
});

test("E: an inbound message routes by integration to the owning business only", async () => {
  const { store, integrations } = await twoTenants();
  const deps = {
    store, integrations, templates, wa: createFakeWa(), config: TEST_CONFIG,
    businesses: createBusinessRegistry([
      { id: "acme", name: "Acme", ownerName: "A", ownerWhatsApp: "+911", phoneNumberId: "111111" },
      { id: "bolt", name: "Bolt", ownerName: "B", ownerWhatsApp: "+912", phoneNumberId: "222222" },
    ]),
  };
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "222222" },
      messages: [{ id: "wamid.B1", from: "919505141818", type: "text", text: { body: "AC not cooling" }, timestamp: "1" }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": signBody(raw) } }, deps).afterAck();

  assert.ok(await scopedToBusiness(store, "bolt").getConversation("+919505141818"));
  assert.equal(await scopedToBusiness(store, "acme").getConversation("+919505141818"), null);
});

// ---- F. status events ----

test("F: a status event cannot update another tenant's message", async () => {
  const { store, integrations } = await twoTenants();
  const acme = scopedToBusiness(store, "acme");
  await acme.saveMessage({
    id: "acme-msg", conversationId: "+919505141818", messageId: "wamid.SHARED",
    direction: "outbound", senderType: "assistant", customerPhone: "+919505141818", text: "acme msg",
  });

  const deps = {
    store, integrations, templates, wa: createFakeWa(), config: TEST_CONFIG,
    businesses: createBusinessRegistry([
      { id: "acme", name: "Acme", ownerName: "A", ownerWhatsApp: "+911", phoneNumberId: "111111" },
      { id: "bolt", name: "Bolt", ownerName: "B", ownerWhatsApp: "+912", phoneNumberId: "222222" },
    ]),
  };
  // Bolt's number reports a status for a wamid that belongs to Acme.
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "222222" },
      statuses: [{ id: "wamid.SHARED", status: "failed" }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  await handleWebhookPost({ rawBody: raw, headers: { "x-hub-signature-256": signBody(raw) } }, deps).afterAck();

  const untouched = (await acme.listMessages("+919505141818"))[0];
  assert.equal(untouched.deliveryStatus, undefined, "another tenant's status must not land on this message");
});

// ---- G/H. secret exposure ----

test("G: the public view contains no credentials", async () => {
  const { integrations } = await twoTenants();
  const view = publicView(await integrations.forBusiness("acme"));
  const json = JSON.stringify(view);

  for (const secret of Object.values(A_SECRETS)) assert.ok(!json.includes(secret));
  assert.ok(!("accessTokenEncrypted" in view), "not even the ciphertext is exposed");
  assert.ok(!("appSecretEncrypted" in view));
  assert.ok(!("verifyTokenEncrypted" in view));
});

test("G: the public view masks identifiers", () => {
  const view = publicView(createIntegration({
    businessId: "acme", phoneNumberId: "1298176060043027", wabaId: "1589702432821550", encryptionKey: KEY,
  }));
  assert.ok(view.phoneNumberId.endsWith("3027"));
  assert.ok(!view.phoneNumberId.includes("1298176060"));
  assert.equal(maskIdentifier("12"), "****");
  assert.equal(maskIdentifier(""), "");
});

test("H: a stored integration record holds no plaintext secret", async () => {
  const { store } = await twoTenants();
  const raw = JSON.stringify(await store.getIntegrationByBusiness("acme"));
  for (const secret of Object.values(A_SECRETS)) {
    assert.ok(!raw.includes(secret), "secrets must be encrypted at rest");
  }
});

// ---- migration-only fallback ----

test("the migration fallback serves only the named default business", async () => {
  const store = createStore(null);
  const integrations = svc(store, {
    META_ACCESS_TOKEN: "ENV-TOKEN", META_PHONE_NUMBER_ID: "555555",
    META_APP_SECRET: "ENV-SECRET", META_VERIFY_TOKEN: "ENV-VERIFY",
  });

  const def = await integrations.forBusiness("default");
  assert.ok(def, "the live business keeps working during migration");
  assert.equal(integrations.secretsOf(def).accessToken, "ENV-TOKEN");

  assert.equal(await integrations.forBusiness("acme"), null,
    "no other business may borrow the global credentials");
});

test("the migration fallback resolves its own phone number and nothing else", async () => {
  const store = createStore(null);
  const integrations = svc(store, { META_ACCESS_TOKEN: "ENV-TOKEN", META_PHONE_NUMBER_ID: "555555" });
  assert.equal((await integrations.byPhoneNumberId("555555")).businessId, "default");
  assert.equal(await integrations.byPhoneNumberId("444444"), null);
});

test("a stored integration takes precedence over the migration fallback", async () => {
  const store = createStore(null);
  const integrations = svc(store, { META_ACCESS_TOKEN: "ENV-TOKEN", META_PHONE_NUMBER_ID: "555555" });
  await integrations.register({ businessId: "default", phoneNumberId: "555555", accessToken: "STORED-TOKEN" });

  const def = await integrations.forBusiness("default");
  assert.equal(integrations.secretsOf(def).accessToken, "STORED-TOKEN",
    "once stored, the encrypted record is authoritative");
});

test("B: a business without an integration cannot send at all", async () => {
  const store = createStore(null);
  const integrations = svc(store);
  assert.equal(await integrations.forBusiness("acme"), null,
    "no integration means no credentials — not someone else's");
});
