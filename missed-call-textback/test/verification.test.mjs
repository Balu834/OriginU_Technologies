/**
 * The CONNECTED state transition.
 *
 * markVerified() existed for weeks with no caller, so CONNECTED was
 * unreachable and "WhatsApp connected" could never tick — a business could
 * wire up a working integration and be told permanently that it had not.
 * These tests pin the transition down in both directions.
 *
 * Meta is mocked at fetch. Every assertion is against the PERSISTED
 * integration record or the value handed to the view — never against
 * rendered markup, which is how this project once convinced itself a CSS
 * class was a connection status.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createIntegrationService, integrationState, publicView } from "../lib/integrations.mjs";
import { createMetaVerifier, FAILURE_REASONS } from "../lib/metaVerify.mjs";
import { loadBusinessRegistry, businessRecord, onboardingStatus } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { handleWhatsappSettingsGet, handleWhatsappSettingsPost } from "../routes/accounts.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const PHONE_A = "111111111111111";
const WABA_A = "222222222222222";
const TOKEN_A = "FAKE-VERIFY-TOKEN-ALPHA";

const PHONE_B = "333333333333333";
const WABA_B = "444444444444444";
const TOKEN_B = "FAKE-VERIFY-TOKEN-BETA";

/**
 * A stand-in Graph API. `world` describes which numbers exist, which token
 * reaches them, and which WABA owns them — so a test can express "the
 * token is fine but the number belongs to someone else" directly.
 */
function fakeMeta({ numbers = {}, wabas = {}, validTokens = [], failNetwork = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url));
    if (failNetwork) throw new Error("connect ECONNREFUSED");

    const token = (options.headers?.Authorization ?? "").replace("Bearer ", "");
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    if (!validTokens.includes(token)) {
      return json(401, { error: { message: "Malformed access token", type: "OAuthException", code: 190, fbtrace_id: "T1" } });
    }

    const wabaMatch = /\/([0-9]+)\/phone_numbers/.exec(String(url));
    if (wabaMatch) {
      const owned = wabas[wabaMatch[1]];
      if (!owned) {
        return json(400, { error: { message: "does not exist", type: "GraphMethodException", code: 100, error_subcode: 33, fbtrace_id: "T2" } });
      }
      return json(200, { data: owned.map((id) => ({ id })) });
    }

    const idMatch = /\/([0-9]+)\?/.exec(String(url));
    const number = idMatch ? numbers[idMatch[1]] : null;
    if (!number) {
      return json(400, { error: { message: "does not exist", type: "GraphMethodException", code: 100, error_subcode: 33, fbtrace_id: "T3" } });
    }
    return json(200, number);
  };
  return { fetchImpl, calls };
}

const healthyNumber = (id) => ({
  id,
  display_phone_number: "+1 555-000-0000",
  verified_name: "Test Number",
  quality_rating: "GREEN",
  platform_type: "CLOUD_API",
  status: "CONNECTED",
});

/** A Meta that says yes to everything tenant A legitimately owns. */
function metaThatAccepts() {
  return fakeMeta({
    numbers: { [PHONE_A]: healthyNumber(PHONE_A), [PHONE_B]: healthyNumber(PHONE_B) },
    wabas: { [WABA_A]: [PHONE_A], [WABA_B]: [PHONE_B] },
    validTokens: [TOKEN_A, TOKEN_B],
  });
}

async function buildWorld({ meta = metaThatAccepts() } = {}) {
  const store = createStore(null);
  const config = {
    ...TEST_CONFIG,
    INTEGRATION_ENCRYPTION_KEY: "b".repeat(64),
    DASHBOARD_PASSWORD_HASH: hashPassword("default-password-x"),
  };
  const accounts = createAccountService(store);
  const integrations = createIntegrationService(store, config);

  const userA = await accounts.signUp({ email: "verify-a@example.test", password: "verify-a-password" });
  const userB = await accounts.signUp({ email: "verify-b@example.test", password: "verify-b-password" });

  const bizA = businessRecord({ id: "vbiz-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: "+911111111111", services: ["Electrical repair"] });
  const bizB = businessRecord({ id: "vbiz-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: "+912222222222", services: ["Plumbing"] });
  await accounts.createBusinessFor(userA, bizA);
  await accounts.createBusinessFor(userB, bizB);

  const businesses = await loadBusinessRegistry(store, config);
  const metaVerifier = createMetaVerifier({ fetchImpl: meta.fetchImpl });

  return {
    store, config, accounts, integrations, businesses, metaVerifier, meta,
    wa: createFakeWa(), templates, userA, userB, bizA, bizB,
  };
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

function ctx({ method = "GET", session, form = null, query = {} }) {
  return {
    method, pathname: "/settings/whatsapp",
    query: new URLSearchParams(query),
    headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
    rawBody: Buffer.from(form ? new URLSearchParams(form).toString() : ""),
  };
}

const submit = (w, session, form) => handleWhatsappSettingsPost(ctx({ method: "POST", session, form }), w);

const CREDS_A = { phoneNumberId: PHONE_A, wabaId: WABA_A, accessToken: TOKEN_A };

// ------------------------------------------------- the verifier itself

test("the verifier accepts credentials Meta confirms, and reports what it saw", async () => {
  const meta = metaThatAccepts();
  const result = await createMetaVerifier({ fetchImpl: meta.fetchImpl }).verify(CREDS_A);

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.details.platformType, "CLOUD_API");
  assert.equal(result.details.numberStatus, "CONNECTED");
  // Both questions were actually asked — the number AND its ownership.
  assert.equal(meta.calls.filter((u) => u.includes("phone_numbers")).length, 1);
  assert.ok(meta.calls.some((u) => u.includes(PHONE_A)));
});

test("the verifier rejects each distinct failure for the right reason", async () => {
  const cases = [
    ["a bad token", { ...CREDS_A, accessToken: "FAKE-WRONG" }, FAILURE_REASONS.INVALID_CREDENTIALS],
    ["a number the token cannot reach", { ...CREDS_A, phoneNumberId: "999999999999999" }, FAILURE_REASONS.NUMBER_NOT_ACCESSIBLE],
    ["no WABA to prove ownership against", { ...CREDS_A, wabaId: "" }, FAILURE_REASONS.WABA_NOT_CONFIGURED],
    ["a WABA that isn't ours", { ...CREDS_A, wabaId: "888888888888888" }, FAILURE_REASONS.WABA_CHECK_FAILED],
    ["someone else's number under our WABA", { ...CREDS_A, phoneNumberId: PHONE_B }, FAILURE_REASONS.WABA_MISMATCH],
    ["nothing at all", {}, FAILURE_REASONS.MISSING_CREDENTIALS],
  ];

  for (const [label, creds, expected] of cases) {
    const meta = metaThatAccepts();
    const result = await createMetaVerifier({ fetchImpl: meta.fetchImpl }).verify(creds);
    assert.equal(result.ok, false, `${label} was accepted`);
    assert.equal(result.reason, expected, `${label} gave the wrong reason`);
  }
});

test("a number Meta does not report as a connected Cloud API number is refused", async () => {
  for (const [field, value, expected] of [
    ["platform_type", "ON_PREMISE", FAILURE_REASONS.NOT_CLOUD_API],
    ["status", "PENDING", FAILURE_REASONS.NUMBER_NOT_CONNECTED],
  ]) {
    const meta = fakeMeta({
      numbers: { [PHONE_A]: { ...healthyNumber(PHONE_A), [field]: value } },
      wabas: { [WABA_A]: [PHONE_A] },
      validTokens: [TOKEN_A],
    });
    const result = await createMetaVerifier({ fetchImpl: meta.fetchImpl }).verify(CREDS_A);
    assert.equal(result.ok, false);
    assert.equal(result.reason, expected);
  }
});

test("an unreachable Meta is a failure, never a pass", async () => {
  const meta = fakeMeta({ failNetwork: true });
  const result = await createMetaVerifier({ fetchImpl: meta.fetchImpl }).verify(CREDS_A);
  assert.equal(result.ok, false);
  assert.equal(result.reason, FAILURE_REASONS.NETWORK_ERROR);
});

test("no verifier result carries the access token", async () => {
  const meta = metaThatAccepts();
  const verifier = createMetaVerifier({ fetchImpl: meta.fetchImpl });
  for (const creds of [CREDS_A, { ...CREDS_A, accessToken: "FAKE-WRONG" }, { ...CREDS_A, wabaId: "" }]) {
    const serialised = JSON.stringify(await verifier.verify(creds));
    assert.ok(!serialised.includes(TOKEN_A), "a verifier result carried the token");
    assert.ok(!serialised.includes("FAKE-WRONG"));
  }
});

// ------------------------------------------- the transition, end to end

test("successful verification calls markVerified and persists CONNECTED", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const before = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(before, null);

  const res = await submit(w, session, { ...CREDS_A });
  assert.equal(res.status, 302);
  assert.match(res.headers.Location, /v=ok/);

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(stored.status, "CONNECTED");
  assert.equal(integrationState(stored), "CONNECTED");
  assert.ok(stored.lastVerifiedAt, "CONNECTED without a verification timestamp");
  assert.ok(!Number.isNaN(Date.parse(stored.lastVerifiedAt)), "lastVerifiedAt is not a real date");
  assert.equal(stored.lastError, null);

  // The transition records evidence; it must not edit the integration.
  assert.equal(stored.businessId, w.bizA.id);
  assert.equal(stored.phoneNumberId, PHONE_A);
  assert.equal(w.integrations.secretsOf(stored).accessToken, TOKEN_A);
});

test("failed verification stores the credentials but never reaches CONNECTED", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await submit(w, session, { ...CREDS_A, accessToken: "FAKE-WRONG-TOKEN" });
  assert.equal(res.status, 302);
  assert.ok(!/v=ok/.test(res.headers.Location));

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(stored.status, "ERROR");
  assert.equal(stored.lastVerifiedAt, null, "a failed verification invented a timestamp");
  assert.equal(stored.lastError, FAILURE_REASONS.INVALID_CREDENTIALS);
  assert.notEqual(integrationState(stored), "CONNECTED");
});

test("a tenant cannot reach CONNECTED on a number another tenant's WABA owns", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  // Tenant A's own WABA, but tenant B's number.
  const res = await submit(w, session, { phoneNumberId: PHONE_B, wabaId: WABA_A, accessToken: TOKEN_A });
  assert.equal(res.status, 302);

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(stored.status, "ERROR");
  assert.equal(stored.lastError, FAILURE_REASONS.WABA_MISMATCH);
  assert.equal(stored.lastVerifiedAt, null);
});

test("re-submitting different credentials drops CONNECTED until re-verified", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  await submit(w, session, { ...CREDS_A });
  const verified = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(verified.status, "CONNECTED");

  // Now rotate to a token Meta rejects. A past verification must not carry
  // forward onto credentials nobody has checked.
  await submit(w, session, { ...CREDS_A, accessToken: "FAKE-ROTATED-BAD" });
  const after = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(after.status, "ERROR");
  assert.equal(after.id, verified.id, "re-registering created a second integration");
});

test("CONNECTED survives a reload, because it is stored rather than derived", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  await submit(w, session, { ...CREDS_A });

  // Fresh service over the same store — nothing cached in memory.
  const reloaded = createIntegrationService(w.store, w.config);
  const stored = await reloaded.forBusiness(w.bizA.id);
  assert.equal(stored.status, "CONNECTED");
  assert.ok(stored.lastVerifiedAt);

  // And the page reports the stored value, not a recomputed one. The
  // business record carries no phoneNumberId at all, which is exactly the
  // case the old derived state got wrong.
  assert.equal(w.businesses.byId(w.bizA.id).phoneNumberId, "");
  assert.equal(integrationState(stored), "CONNECTED");
});

test("missing credentials never produce a connected state", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  for (const form of [{ phoneNumberId: "", accessToken: "" }, { phoneNumberId: PHONE_A, accessToken: "" }, { phoneNumberId: "", accessToken: TOKEN_A }]) {
    const res = await submit(w, session, form);
    assert.equal(res.status, 400);
    assert.equal(await w.integrations.forBusiness(w.bizA.id), null);
  }
  assert.equal(integrationState(null), "NOT_CONNECTED");
});

test("without a verifier wired, the integration stays CONFIGURED rather than assumed good", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const res = await handleWhatsappSettingsPost(
    ctx({ method: "POST", session, form: { ...CREDS_A } }),
    { ...w, metaVerifier: null }
  );
  assert.equal(res.status, 302);

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.equal(stored.status, "CONFIGURED");
  assert.equal(stored.lastVerifiedAt, null);
});

// -------------------------------------------------------- onboarding

test("onboarding completes once the connection is genuinely verified", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);

  const before = onboardingStatus(w.bizA, { connection: integrationState(null) });
  assert.equal(before.WHATSAPP_CONNECTED, false);
  assert.equal(before.ONBOARDING_COMPLETE, false);

  await submit(w, session, { ...CREDS_A });
  const stored = await w.integrations.forBusiness(w.bizA.id);
  const after = onboardingStatus(w.bizA, { connection: integrationState(stored) });

  assert.equal(after.PROFILE_COMPLETE, true);
  assert.equal(after.AI_CONFIGURED, true);
  assert.equal(after.WHATSAPP_CONNECTED, true, "a verified connection still did not tick");
  assert.equal(after.ONBOARDING_COMPLETE, true, "onboarding could not complete even fully verified");
});

test("onboarding does not complete on a failed verification", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  await submit(w, session, { ...CREDS_A, accessToken: "FAKE-WRONG-TOKEN" });

  const stored = await w.integrations.forBusiness(w.bizA.id);
  const status = onboardingStatus(w.bizA, { connection: integrationState(stored) });
  assert.equal(status.connection, "ERROR");
  assert.equal(status.WHATSAPP_CONNECTED, false);
  assert.equal(status.ONBOARDING_COMPLETE, false);
});

// ------------------------------------------------ secrets and isolation

test("no settings response carries a credential, verified or failed", async () => {
  const w = await buildWorld();
  const session = await sessionFor(w, w.userA);
  const bodies = [];

  bodies.push(JSON.stringify(await submit(w, session, { ...CREDS_A })));
  bodies.push((await handleWhatsappSettingsGet(ctx({ session, query: { v: "ok" } }), w)).html);
  bodies.push(JSON.stringify(await submit(w, session, { ...CREDS_A, accessToken: "FAKE-WRONG-TOKEN" })));
  bodies.push((await handleWhatsappSettingsGet(ctx({ session, query: { v: "invalid_credentials" } }), w)).html);

  const all = bodies.join("\n");
  for (const secret of [TOKEN_A, TOKEN_B, "FAKE-WRONG-TOKEN", w.userA.passwordHash]) {
    assert.ok(!all.includes(secret), "a settings response carried a credential");
  }

  const stored = await w.integrations.forBusiness(w.bizA.id);
  assert.ok(!all.includes(stored.accessTokenEncrypted), "a settings response leaked the ciphertext");

  const view = publicView(stored);
  assert.ok(!JSON.stringify(view).includes(TOKEN_A));
  assert.equal(view.status, "ERROR");
  assert.equal(view.lastError, FAILURE_REASONS.INVALID_CREDENTIALS);
});

test("verifying one tenant leaves the other tenant's integration untouched", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.userA);
  const sessionB = await sessionFor(w, w.userB);

  await submit(w, sessionB, { phoneNumberId: PHONE_B, wabaId: WABA_B, accessToken: TOKEN_B });
  const beforeB = await w.integrations.forBusiness(w.bizB.id);
  assert.equal(beforeB.status, "CONNECTED");

  // A verifies its own, and separately fails — neither may touch B.
  await submit(w, sessionA, { ...CREDS_A });
  await submit(w, sessionA, { ...CREDS_A, accessToken: "FAKE-WRONG-TOKEN" });

  const afterB = await w.integrations.forBusiness(w.bizB.id);
  assert.deepEqual(afterB, beforeB, "one tenant's verification altered another's integration");
  assert.equal(w.integrations.secretsOf(afterB).accessToken, TOKEN_B);
});

test("the form's businessId is ignored when verifying, as everywhere else", async () => {
  const w = await buildWorld();
  const sessionA = await sessionFor(w, w.userA);

  await submit(w, sessionA, { ...CREDS_A, businessId: w.bizB.id, role: "OWNER" });

  assert.equal((await w.integrations.forBusiness(w.bizA.id)).status, "CONNECTED");
  assert.equal(await w.integrations.forBusiness(w.bizB.id), null, "the verification landed on the wrong tenant");
});
