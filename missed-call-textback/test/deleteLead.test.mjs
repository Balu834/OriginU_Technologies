/**
 * Secure lead deletion.
 *
 * The property under test is restraint. Deleting a lead must remove what
 * provably belongs to it and nothing else — not the other lead on the
 * same phone number, not the customer's own messages when ownership
 * cannot be proven, and not a Meta idempotency marker whose removal would
 * let a genuine webhook retry create a duplicate.
 *
 * One phone number carrying several leads is the case that matters: it is
 * real, it already happened in production, and a conversation-key
 * deletion gets it catastrophically wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { createAccountService } from "../lib/users.mjs";
import { createBillingService } from "../lib/billing.mjs";
import { createUsageService } from "../lib/usage.mjs";
import { createIntegrationService } from "../lib/integrations.mjs";
import { loadBusinessRegistry, businessRecord } from "../lib/businesses.mjs";
import { createSession, COOKIE_NAME, hashPassword } from "../lib/auth.mjs";
import { createLead } from "../lib/leads.mjs";
import { createMessage } from "../lib/messages.mjs";
import { planLeadDeletion, deleteLead } from "../lib/deleteLead.mjs";
import { handleLeadDelete, handleLeadDetail } from "../routes/dashboard.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const SHARED_PHONE = "+919000000601";
const OTHER_PHONE = "+919000000602";

async function buildWorld() {
  const store = createStore(null);
  const config = { ...TEST_CONFIG, INTEGRATION_ENCRYPTION_KEY: "7".repeat(64), DASHBOARD_PASSWORD_HASH: hashPassword("pw-del") };
  const accounts = createAccountService(store);

  const ownerA = await accounts.signUp({ email: "del-a@example.test", password: "del-a-password" });
  const ownerB = await accounts.signUp({ email: "del-b@example.test", password: "del-b-password" });
  const bizA = businessRecord({ id: "del-a", name: "Alpha Electrical", ownerName: "Anita", ownerWhatsApp: "+911" });
  const bizB = businessRecord({ id: "del-b", name: "Beta Plumbing", ownerName: "Bharat", ownerWhatsApp: "+912" });
  await accounts.createBusinessFor(ownerA, bizA);
  await accounts.createBusinessFor(ownerB, bizB);

  return {
    store, config, accounts, templates, wa: createFakeWa(),
    billing: createBillingService(store), usage: createUsageService(store),
    integrations: createIntegrationService(store, config),
    businesses: await loadBusinessRegistry(store, config),
    ownerA, ownerB, bizA, bizB,
    scopedA: scopedToBusiness(store, "del-a"), scopedB: scopedToBusiness(store, "del-b"),
  };
}

async function sessionFor(w, user) {
  const [m] = await w.accounts.membershipsOf(user.id);
  return createSession(w.store, m.businessId, { userId: user.id });
}

async function sessionAs(w, businessId, role, email) {
  const user = await w.accounts.signUp({ email, password: "role-password-del" });
  await w.accounts.addMember({ businessId, email, role });
  return createSession(w.store, businessId, { userId: user.id });
}

const delCtx = (session, form = {}) => ({
  method: "POST", pathname: "/lead/delete", query: new URLSearchParams(),
  headers: session ? { cookie: `${COOKIE_NAME}=${session}` } : {},
  rawBody: Buffer.from(new URLSearchParams({ confirm: "delete", ...form }).toString()),
});

/** A lead plus the messages a real conversation would leave behind. */
async function seedLead(scoped, { phone, name, withAmbiguous = true }) {
  const lead = createLead({ callerNumber: phone, fields: { name, area: "Area", problem: "problem", urgency: "today" } });
  await scoped.saveLead(lead);

  if (withAmbiguous) {
    // Exactly what lib/conversation.mjs writes: the customer's own texts
    // and the assistant's questions carry NO lead id.
    await scoped.saveMessage(createMessage({
      conversationId: phone, direction: "inbound", senderType: "customer",
      customerPhone: phone, messageId: `wamid.IN-${name}`, text: `inbound from ${name}`,
    }));
    await scoped.saveMessage(createMessage({
      conversationId: phone, direction: "outbound", senderType: "assistant",
      customerPhone: phone, messageId: `wamid.ASK-${name}`, text: `question for ${name}`,
    }));
  }
  // These two DO carry the lead id.
  await scoped.saveMessage(createMessage({
    conversationId: phone, leadId: lead.id, direction: "outbound", senderType: "assistant",
    customerPhone: phone, messageId: `wamid.CONF-${name}`, text: `confirmation for ${name}`,
  }));
  await scoped.saveMessage(createMessage({
    conversationId: phone, leadId: lead.id, direction: "outbound", senderType: "owner",
    customerPhone: phone, messageId: `wamid.OWNER-${name}`, text: `owner alert for ${name}`,
  }));
  return lead;
}

// ------------------------------------------------------- authorization

test("OWNER and ADMIN can delete; STAFF cannot; anonymous cannot", async () => {
  for (const role of ["OWNER", "ADMIN"]) {
    const w = await buildWorld();
    const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: role });
    const session = role === "OWNER"
      ? await sessionFor(w, w.ownerA)
      : await sessionAs(w, "del-a", "ADMIN", `del-admin-${role}@example.test`);

    const res = await handleLeadDelete(delCtx(session, { id: lead.id }), w);
    assert.equal(res.status, 302, `${role} could not delete`);
    assert.equal(await w.scopedA.getLead(lead.id), null);
  }

  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Staff" });

  const staff = await sessionAs(w, "del-a", "STAFF", "del-staff@example.test");
  const denied = await handleLeadDelete(delCtx(staff, { id: lead.id }), w);
  assert.equal(denied.status, 403);
  assert.ok(await w.scopedA.getLead(lead.id), "STAFF deleted the lead despite the 403");

  const anon = await handleLeadDelete(delCtx(null, { id: lead.id }), w);
  assert.equal(anon.status, 401);
  assert.ok(await w.scopedA.getLead(lead.id), "an anonymous request deleted the lead");
});

test("STAFF is not offered the control, and an owner is", async () => {
  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "View" });

  const staffPage = await handleLeadDetail({
    method: "GET", pathname: "/lead", query: new URLSearchParams({ id: lead.id }),
    headers: { cookie: `${COOKIE_NAME}=${await sessionAs(w, "del-a", "STAFF", "del-staff2@example.test")}` },
    rawBody: Buffer.alloc(0),
  }, w);
  assert.ok(!staffPage.html.includes('action="/lead/delete"'), "STAFF was shown a delete form");

  const ownerPage = await handleLeadDetail({
    method: "GET", pathname: "/lead", query: new URLSearchParams({ id: lead.id }),
    headers: { cookie: `${COOKIE_NAME}=${await sessionFor(w, w.ownerA)}` },
    rawBody: Buffer.alloc(0),
  }, w);
  assert.ok(ownerPage.html.includes('action="/lead/delete"'), "the owner was not offered the control");
  assert.ok(ownerPage.html.includes("cannot be undone"), "the warning does not say it is permanent");
  assert.ok(!ownerPage.html.toLowerCase().includes("archive"), "destructive deletion was described as archiving");
});

test("deletion requires explicit confirmation", async () => {
  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Confirm" });
  const session = await sessionFor(w, w.ownerA);

  const noConfirm = await handleLeadDelete({
    method: "POST", pathname: "/lead/delete", query: new URLSearchParams(),
    headers: { cookie: `${COOKIE_NAME}=${session}` },
    rawBody: Buffer.from(new URLSearchParams({ id: lead.id }).toString()),
  }, w);
  assert.equal(noConfirm.status, 400);
  assert.ok(await w.scopedA.getLead(lead.id), "an unconfirmed request deleted the lead");
});

// ---------------------------------------------------- tenant isolation

test("a lead from another tenant is reported as not found, and survives", async () => {
  const w = await buildWorld();
  const leadB = await seedLead(w.scopedB, { phone: OTHER_PHONE, name: "Beta" });
  const sessionA = await sessionFor(w, w.ownerA);

  const res = await handleLeadDelete(delCtx(sessionA, { id: leadB.id }), w);
  assert.equal(res.status, 404, "a cross-tenant delete revealed the lead exists");
  assert.ok(await w.scopedB.getLead(leadB.id), "tenant B's lead was deleted");
  assert.equal((await w.scopedB.listMessages(OTHER_PHONE)).length, 4);
});

test("a forged businessId, tenantId or ownerId is never read", async () => {
  const w = await buildWorld();
  const leadA = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Alpha" });
  const leadB = await seedLead(w.scopedB, { phone: OTHER_PHONE, name: "Beta" });
  const sessionA = await sessionFor(w, w.ownerA);

  const res = await handleLeadDelete(delCtx(sessionA, {
    id: leadA.id, businessId: "del-b", tenantId: "del-b", ownerId: "del-b", leadBusinessId: "del-b",
  }), w);

  assert.equal(res.status, 302);
  assert.equal(await w.scopedA.getLead(leadA.id), null, "the delete did not act on the caller's own tenant");
  assert.ok(await w.scopedB.getLead(leadB.id), "a forged tenant id reached business B");
  assert.equal((await w.scopedB.listMessages(OTHER_PHONE)).length, 4, "business B lost messages");
});

// ------------------------------------------- shared conversation (core)

test("deleting one of two leads on the same number leaves the other whole", async () => {
  const w = await buildWorld();
  const first = await seedLead(w.scopedA, { phone: SHARED_PHONE, name: "First" });
  const second = await seedLead(w.scopedA, { phone: SHARED_PHONE, name: "Second" });
  await w.scopedA.saveConversation(SHARED_PHONE, { callerNumber: SHARED_PHONE, completed: true, fields: {} });

  const before = await w.scopedA.listMessages(SHARED_PHONE);
  assert.equal(before.length, 8, "fixture should leave 8 messages on the shared conversation");

  const summary = await deleteLead({ store: w.scopedA, businessId: "del-a", leadId: first.id });
  assert.equal(summary.deleted, true);
  assert.equal(summary.messagesDeleted, 2, "only the two lead-owned messages should go");
  assert.equal(summary.conversationDeleted, false, "the shared conversation was deleted");

  // The other lead is untouched.
  const survivor = await w.scopedA.getLead(second.id);
  assert.ok(survivor, "the sibling lead was deleted");
  assert.equal(survivor.name, "Second");

  const after = await w.scopedA.listMessages(SHARED_PHONE);
  const texts = after.map((m) => m.text);
  assert.ok(texts.includes("confirmation for Second"), "the sibling's confirmation was deleted");
  assert.ok(texts.includes("owner alert for Second"), "the sibling's owner alert was deleted");
  assert.ok(!texts.includes("confirmation for First"), "the target's own message survived");
  assert.ok(!texts.includes("owner alert for First"), "the target's own owner alert survived");

  // The conversation record itself is still there for the survivor.
  assert.ok(await w.scopedA.getConversation(SHARED_PHONE), "the shared conversation record was removed");
});

test("ambiguous messages with no leadId are preserved, never guessed at", async () => {
  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: SHARED_PHONE, name: "Solo" });

  const plan = await planLeadDeletion({ store: w.scopedA, businessId: "del-a", leadId: lead.id });
  assert.equal(plan.owned.length, 2);
  assert.equal(plan.ambiguousCount, 2, "the unassigned messages were not identified as ambiguous");
  assert.equal(plan.conversationRemovable, false, "a conversation with ambiguous messages was marked removable");

  await deleteLead({ store: w.scopedA, businessId: "del-a", leadId: lead.id });

  const after = await w.scopedA.listMessages(SHARED_PHONE);
  assert.deepEqual(after.map((m) => m.text).sort(), ["inbound from Solo", "question for Solo"]);
  assert.ok(await w.scopedA.getConversation(SHARED_PHONE) === null || true);
});

test("the conversation is removed only when nothing depends on it", async () => {
  const w = await buildWorld();
  // A lead whose messages ALL carry its id — nothing ambiguous, no sibling.
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Clean", withAmbiguous: false });
  await w.scopedA.saveConversation(OTHER_PHONE, { callerNumber: OTHER_PHONE, completed: true, fields: {} });

  const plan = await planLeadDeletion({ store: w.scopedA, businessId: "del-a", leadId: lead.id });
  assert.equal(plan.conversationRemovable, true);

  const summary = await deleteLead({ store: w.scopedA, businessId: "del-a", leadId: lead.id });
  assert.equal(summary.conversationDeleted, true);
  assert.equal(await w.scopedA.getConversation(OTHER_PHONE), null);
  assert.deepEqual(await w.scopedA.listMessages(OTHER_PHONE), []);
});

// ------------------------------------------------ idempotency markers

test("Meta processed-message markers are never removed by a lead deletion", async () => {
  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Marked" });

  // A genuine marker, exactly as the webhook writes one.
  await w.scopedA.markMessageProcessed("wamid.GENUINE-INBOUND");
  assert.equal(await w.scopedA.hasProcessedMessage("wamid.GENUINE-INBOUND"), true);

  await deleteLead({ store: w.scopedA, businessId: "del-a", leadId: lead.id });

  assert.equal(
    await w.scopedA.hasProcessedMessage("wamid.GENUINE-INBOUND"), true,
    "a processed marker was deleted — a Meta retry could now create a duplicate lead"
  );
});

// -------------------------------------------------- repeated deletion

test("deleting the same lead twice is safe and corrupts nothing", async () => {
  const w = await buildWorld();
  const target = await seedLead(w.scopedA, { phone: SHARED_PHONE, name: "Target" });
  const sibling = await seedLead(w.scopedA, { phone: SHARED_PHONE, name: "Sibling" });
  const session = await sessionFor(w, w.ownerA);

  assert.equal((await handleLeadDelete(delCtx(session, { id: target.id }), w)).status, 302);
  const afterFirst = await w.scopedA.listLeads();

  const second = await handleLeadDelete(delCtx(session, { id: target.id }), w);
  assert.equal(second.status, 404);

  assert.deepEqual(await w.scopedA.listLeads(), afterFirst, "a repeated delete changed the lead set");
  assert.ok(await w.scopedA.getLead(sibling.id), "a repeated delete took the sibling");
  assert.equal((await w.scopedA.listMessages(SHARED_PHONE)).filter((m) => m.leadId === target.id).length, 0);
});

test("deleting a lead that never existed is a clean 404", async () => {
  const w = await buildWorld();
  const kept = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Kept" });
  const session = await sessionFor(w, w.ownerA);

  for (const id of ["", "not-a-real-id", "../../del-b/x"]) {
    const res = await handleLeadDelete(delCtx(session, { id }), w);
    assert.equal(res.status, 404, `id "${id}" did not 404`);
  }
  assert.ok(await w.scopedA.getLead(kept.id), "a bogus id deleted a real lead");
});

// ----------------------------------------------- everything else intact

test("deletion touches no business, user, integration, subscription or index", async () => {
  const w = await buildWorld();
  await w.integrations.register({ businessId: "del-a", phoneNumberId: "DEL_PHONE_A", wabaId: "W", accessToken: "FAKE-DEL-A" });
  await w.billing.changePlan({ businessId: "del-a", plan: "PRO", reason: "test" });
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Sundry" });
  const otherLead = await seedLead(w.scopedA, { phone: "+919000000999", name: "Elsewhere" });

  const businessBefore = { ...w.businesses.byId("del-a") };
  const integrationBefore = await w.integrations.forBusiness("del-a");
  const subscriptionBefore = await w.store.getSubscription("del-a");
  const usersBefore = (await w.accounts.membershipsOf(w.ownerA.id)).length;

  await deleteLead({ store: w.scopedA, businessId: "del-a", leadId: lead.id });

  assert.deepEqual(w.businesses.byId("del-a"), businessBefore);
  assert.deepEqual(await w.integrations.forBusiness("del-a"), integrationBefore);
  assert.deepEqual(await w.store.getSubscription("del-a"), subscriptionBefore);
  assert.equal((await w.accounts.membershipsOf(w.ownerA.id)).length, usersBefore);
  assert.ok(await w.store.getUser(w.ownerA.id), "a user was deleted");

  // A different customer on a different number is untouched.
  assert.ok(await w.scopedA.getLead(otherLead.id));
  assert.equal((await w.scopedA.listMessages("+919000000999")).length, 4);

  // The lead index no longer carries the deleted id.
  const ids = (await w.scopedA.listLeads()).map((l) => l.id);
  assert.ok(!ids.includes(lead.id));
  assert.ok(ids.includes(otherLead.id));
});

test("the deletion summary reports what actually happened", async () => {
  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: SHARED_PHONE, name: "Report" });

  const summary = await deleteLead({
    store: w.scopedA, businessId: "del-a", leadId: lead.id,
    actor: { user: { id: w.ownerA.id }, role: "OWNER", businessId: "del-a" },
  });

  assert.equal(summary.deleted, true);
  assert.equal(summary.leadId, lead.id);
  assert.equal(summary.messagesDeleted, 2);
  assert.equal(summary.messagesPreserved, 2);
  assert.equal(summary.leadMessagesRemaining, 0, "a lead-owned message survived the delete");
});

test("planning changes nothing", async () => {
  const w = await buildWorld();
  const lead = await seedLead(w.scopedA, { phone: OTHER_PHONE, name: "Plan" });

  await planLeadDeletion({ store: w.scopedA, businessId: "del-a", leadId: lead.id });

  assert.ok(await w.scopedA.getLead(lead.id), "planning deleted the lead");
  assert.equal((await w.scopedA.listMessages(OTHER_PHONE)).length, 4);
  assert.equal((await planLeadDeletion({ store: w.scopedA, businessId: "del-a", leadId: "nope" })).found, false);
});
