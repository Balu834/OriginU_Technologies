/**
 * Self-service accounts, memberships, roles and settings authorization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { createAccountService, resolveActor, can, publicUser, isValidEmail, isAcceptablePassword } from "../lib/users.mjs";
import { createIntegrationService, publicView } from "../lib/integrations.mjs";
import { createBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, verifyPassword } from "../lib/auth.mjs";
import {
  handleSignupPost, handleOnboardingPost,
  handleWhatsappSettingsGet, handleWhatsappSettingsPost,
  handleTeamGet, handleTeamPost,
} from "../routes/accounts.mjs";
import { generateEncryptionKey } from "../lib/crypto.mjs";
import { createFakeWa, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const KEY = generateEncryptionKey();
const PW = "a-long-enough-password";
const form = (f) => Buffer.from(new URLSearchParams(f).toString());

function deps(store = createStore(null)) {
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: KEY, MIGRATION_DEFAULT_BUSINESS_ID: "default" };
  return {
    store, config, templates, wa: createFakeWa(),
    accounts: createAccountService(store),
    integrations: createIntegrationService(store, config),
    businesses: createBusinessRegistry([]),
  };
}

async function signedUpUser(d, email) {
  const user = await d.accounts.signUp({ email, password: PW });
  const biz = businessRecord({ id: `biz-${email}`, name: `${email} Ltd`, ownerName: "O", ownerWhatsApp: "+911" });
  await d.accounts.createBusinessFor(user, biz);
  d.businesses = createBusinessRegistry([...d.businesses.list(), biz]);
  const sid = await createSession(d.store, biz.id, { userId: user.id });
  return { user, business: biz, cookie: `${COOKIE_NAME}=${sid}` };
}

// ---- password + signup ----

test("passwords are hashed, never stored in plaintext", async () => {
  const d = deps();
  const user = await d.accounts.signUp({ email: "a@example.com", password: PW });
  assert.ok(!JSON.stringify(user).includes(PW));
  assert.ok(user.passwordHash.includes(":"), "scrypt salt:hash");
  assert.equal(verifyPassword(PW, user.passwordHash), true);
});

test("publicUser never exposes the password hash", async () => {
  const d = deps();
  const user = await d.accounts.signUp({ email: "a@example.com", password: PW });
  const view = publicUser(user);
  assert.ok(!("passwordHash" in view));
  assert.ok(!JSON.stringify(view).includes(user.passwordHash));
});

test("weak input is rejected", () => {
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isAcceptablePassword("short"), false);
  assert.equal(isAcceptablePassword(PW), true);
});

test("a duplicate email cannot create a second account", async () => {
  const d = deps();
  assert.ok(await d.accounts.signUp({ email: "a@example.com", password: PW }));
  assert.equal(await d.accounts.signUp({ email: "a@example.com", password: PW }), null);
  assert.equal(await d.accounts.signUp({ email: "A@Example.com", password: PW }), null, "case must not create a twin");
});

test("signup does not reveal whether an email is already registered", async () => {
  const d = deps();
  await d.accounts.signUp({ email: "taken@example.com", password: PW });

  const taken = await handleSignupPost({ headers: {}, rawBody: form({ email: "taken@example.com", password: PW }) }, d);
  const fresh = await handleSignupPost({ headers: {}, rawBody: form({ email: "free@example.com", password: PW }) }, d);

  // Compare the rendered error, not the whole page — the page legitimately
  // contains the word "already" in its "Already have one?" sign-in link.
  const errorOf = (html) => html.match(/<p class="error">([^<]*)<\/p>/)?.[1] ?? null;

  assert.equal(taken.status, 400);
  assert.equal(errorOf(taken.html), "Could not create that account.",
    "a taken email must not produce a distinguishable message");
  assert.equal(fresh.status, 302, "a genuinely new account succeeds");
  assert.equal(errorOf(fresh.html ?? ""), null);
});

test("authenticate rejects a wrong password and an unknown user", async () => {
  const d = deps();
  await d.accounts.signUp({ email: "a@example.com", password: PW });
  assert.ok(await d.accounts.authenticate({ email: "a@example.com", password: PW }));
  assert.equal(await d.accounts.authenticate({ email: "a@example.com", password: "wrong-password-x" }), null);
  assert.equal(await d.accounts.authenticate({ email: "nobody@example.com", password: PW }), null);
});

// ---- membership + roles ----

test("the business creator becomes OWNER, server-side", async () => {
  const d = deps();
  const user = await d.accounts.signUp({ email: "owner@example.com", password: PW });
  const biz = businessRecord({ id: "b1", name: "Acme" });
  await d.accounts.createBusinessFor(user, biz);
  assert.equal((await d.accounts.membershipFor(user.id, "b1")).role, "OWNER");
});

test("a client cannot nominate its own role at onboarding", async () => {
  const d = deps();
  const user = await d.accounts.signUp({ email: "x@example.com", password: PW });
  const sid = await createSession(d.store, null, { userId: user.id });

  await handleOnboardingPost(
    { headers: { cookie: `${COOKIE_NAME}=${sid}` }, rawBody: form({ name: "Acme", role: "STAFF", businessId: "hijack" }) },
    d
  );

  const memberships = await d.accounts.membershipsOf(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, "OWNER", "role comes from the server, not the form");
  assert.notEqual(memberships[0].businessId, "hijack", "nor does the business id");
});

test("role permissions are what they claim", () => {
  assert.equal(can("OWNER", "manageTeam"), true);
  assert.equal(can("ADMIN", "manageTeam"), false);
  assert.equal(can("ADMIN", "manageSettings"), true);
  assert.equal(can("STAFF", "manageSettings"), false);
  assert.equal(can("STAFF", "viewLeads"), true);
  assert.equal(can("nonsense", "viewLeads"), false);
});

test("resolveActor derives role from the stored membership, not the session", async () => {
  const d = deps();
  const { user, business } = await signedUpUser(d, "a@example.com");
  // A session claiming ADMIN must not confer it.
  const actor = await resolveActor({ userId: user.id, businessId: business.id, role: "ADMIN" }, d.accounts);
  assert.equal(actor.role, "OWNER", "the membership is authoritative");
});

test("a session for a business the user has no membership in resolves to nothing", async () => {
  const d = deps();
  const { user } = await signedUpUser(d, "a@example.com");
  assert.equal(await resolveActor({ userId: user.id, businessId: "someone-elses" }, d.accounts), null);
});

// ---- settings authorization ----

test("STAFF cannot register or change WhatsApp credentials", async () => {
  const d = deps();
  const { user, business } = await signedUpUser(d, "owner@example.com");
  const staff = await d.accounts.signUp({ email: "staff@example.com", password: PW });
  await d.accounts.addMember({ businessId: business.id, email: "staff@example.com", role: "STAFF" });
  const sid = await createSession(d.store, business.id, { userId: staff.id });

  const res = await handleWhatsappSettingsPost(
    { headers: { cookie: `${COOKIE_NAME}=${sid}` },
      rawBody: form({ phoneNumberId: "999", accessToken: "STAFF-TOKEN" }) },
    d
  );

  assert.equal(res.status, 403);
  assert.equal(await d.integrations.forBusiness(business.id), null, "nothing may be written");
});

test("OWNER can register an integration and it is stored encrypted", async () => {
  const d = deps();
  const { business, cookie } = await signedUpUser(d, "owner@example.com");

  await handleWhatsappSettingsPost(
    { headers: { cookie }, rawBody: form({ phoneNumberId: "123456", accessToken: "OWNER-TOKEN", appSecret: "OWNER-SECRET" }) },
    d
  );

  const integration = await d.integrations.forBusiness(business.id);
  assert.ok(integration);
  assert.equal(d.integrations.secretsOf(integration).accessToken, "OWNER-TOKEN");
  assert.ok(!JSON.stringify(integration).includes("OWNER-TOKEN"), "encrypted at rest");
});

test("a newly registered integration is CONFIGURED, never CONNECTED", async () => {
  const d = deps();
  const { business, cookie } = await signedUpUser(d, "owner@example.com");
  await handleWhatsappSettingsPost(
    { headers: { cookie }, rawBody: form({ phoneNumberId: "123456", accessToken: "T" }) }, d
  );
  assert.equal((await d.integrations.forBusiness(business.id)).status, "CONFIGURED");
});

test("the settings page never renders a credential", async () => {
  const d = deps();
  const { cookie, business } = await signedUpUser(d, "owner@example.com");
  await handleWhatsappSettingsPost(
    { headers: { cookie }, rawBody: form({ phoneNumberId: "123456", accessToken: "SUPER-SECRET-TOKEN", appSecret: "SUPER-SECRET-APP" }) },
    d
  );

  const res = await handleWhatsappSettingsGet({ headers: { cookie } }, d);
  assert.ok(!res.html.includes("SUPER-SECRET-TOKEN"));
  assert.ok(!res.html.includes("SUPER-SECRET-APP"));
  assert.ok(!res.html.includes("accessTokenEncrypted"));
  assert.match(res.html, /CONFIGURED/);
});

test("unauthenticated settings access is refused", async () => {
  const d = deps();
  const res = await handleWhatsappSettingsGet({ headers: {} }, d);
  assert.equal(res.status, 302);
  const post = await handleWhatsappSettingsPost({ headers: {}, rawBody: form({ phoneNumberId: "1", accessToken: "t" }) }, d);
  assert.equal(post.status, 302);
});

// ---- cross-tenant ----

test("one business cannot register a phone number another already owns", async () => {
  const d = deps();
  const a = await signedUpUser(d, "a@example.com");
  const b = await signedUpUser(d, "b@example.com");

  await handleWhatsappSettingsPost({ headers: { cookie: a.cookie }, rawBody: form({ phoneNumberId: "111", accessToken: "A" }) }, d);
  const res = await handleWhatsappSettingsPost({ headers: { cookie: b.cookie }, rawBody: form({ phoneNumberId: "111", accessToken: "B" }) }, d);

  assert.equal(res.status, 409);
  assert.equal(d.integrations.secretsOf(await d.integrations.forBusiness(a.business.id)).accessToken, "A");
});

test("a business only ever sees its own integration", async () => {
  const d = deps();
  const a = await signedUpUser(d, "a@example.com");
  const b = await signedUpUser(d, "b@example.com");
  await handleWhatsappSettingsPost({ headers: { cookie: a.cookie }, rawBody: form({ phoneNumberId: "111", accessToken: "A-TOKEN" }) }, d);

  const res = await handleWhatsappSettingsGet({ headers: { cookie: b.cookie } }, d);
  assert.doesNotMatch(res.html, /A-TOKEN/);
  assert.match(res.html, /NOT_CONNECTED/, "B has no integration of its own");
});

test("a businessId in the form cannot redirect an integration to another tenant", async () => {
  const d = deps();
  const a = await signedUpUser(d, "a@example.com");
  const b = await signedUpUser(d, "b@example.com");

  await handleWhatsappSettingsPost(
    { headers: { cookie: a.cookie }, rawBody: form({ phoneNumberId: "111", accessToken: "A", businessId: b.business.id }) },
    d
  );

  assert.ok(await d.integrations.forBusiness(a.business.id), "it lands on the acting business");
  assert.equal(await d.integrations.forBusiness(b.business.id), null, "and not the one named in the form");
});

test("leads stay isolated between self-service businesses", async () => {
  const d = deps();
  const a = await signedUpUser(d, "a@example.com");
  const b = await signedUpUser(d, "b@example.com");
  await scopedToBusiness(d.store, a.business.id).saveLead({ id: "l1", name: "A customer", callerNumber: "+911", status: "new" });

  assert.equal((await scopedToBusiness(d.store, b.business.id).listLeads()).length, 0);
  assert.equal((await scopedToBusiness(d.store, a.business.id).listLeads()).length, 1);
});

// ---- team ----

test("OWNER can add an ADMIN; ADMIN cannot manage the team", async () => {
  const d = deps();
  const owner = await signedUpUser(d, "owner@example.com");
  await d.accounts.signUp({ email: "admin@example.com", password: PW });

  await handleTeamPost({ headers: { cookie: owner.cookie }, rawBody: form({ email: "admin@example.com", role: "ADMIN" }) }, d);
  const members = await d.accounts.membersOf(owner.business.id);
  assert.equal(members.length, 2);

  const admin = await d.accounts.findByEmail("admin@example.com");
  const adminSid = await createSession(d.store, owner.business.id, { userId: admin.id });
  const res = await handleTeamPost(
    { headers: { cookie: `${COOKIE_NAME}=${adminSid}` }, rawBody: form({ email: "x@example.com", role: "STAFF" }) }, d
  );
  assert.equal(res.status, 403);
});

test("nobody can be added as OWNER through the team form", async () => {
  const d = deps();
  const owner = await signedUpUser(d, "owner@example.com");
  await d.accounts.signUp({ email: "sneaky@example.com", password: PW });

  const res = await handleTeamPost(
    { headers: { cookie: owner.cookie }, rawBody: form({ email: "sneaky@example.com", role: "OWNER" }) }, d
  );
  assert.equal(res.status, 400);
  assert.equal((await d.accounts.membersOf(owner.business.id)).length, 1);
});

test("the last OWNER cannot be removed", async () => {
  const d = deps();
  const owner = await signedUpUser(d, "owner@example.com");
  const members = await d.accounts.membersOf(owner.business.id);
  const removed = await d.accounts.removeMember({ businessId: owner.business.id, membershipId: members[0].id });
  assert.equal(removed, false);
  assert.equal((await d.accounts.membersOf(owner.business.id)).length, 1);
});

test("the team page shows emails but never password hashes", async () => {
  const d = deps();
  const owner = await signedUpUser(d, "owner@example.com");
  const res = await handleTeamGet({ headers: { cookie: owner.cookie } }, d);
  assert.match(res.html, /owner@example\.com/);
  const user = await d.accounts.findByEmail("owner@example.com");
  assert.ok(!res.html.includes(user.passwordHash));
});

// ---- default business compatibility ----

test("a legacy per-business session still acts as OWNER of its business", async () => {
  const d = deps();
  const actor = await resolveActor({ businessId: "default" }, d.accounts);
  assert.equal(actor.businessId, "default");
  assert.equal(actor.role, "OWNER");
  assert.equal(actor.legacy, true);
});

test("an empty session resolves to no actor at all", async () => {
  const d = deps();
  assert.equal(await resolveActor(null, d.accounts), null);
  assert.equal(await resolveActor({}, d.accounts), null);
});
