/**
 * Lead lifecycle: status transitions, priority (separate from status),
 * audit timestamps, and the notification retry path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, scopedToBusiness } from "../lib/store.mjs";
import { canTransition, allowedTransitions, isValidPriority, leadPriority, createLead } from "../lib/leads.mjs";
import { handleLeadStatus, handleLeadPriority, handleRetryNotification, handleLeadDetail } from "../routes/dashboard.mjs";
import { createSession, hashPassword, COOKIE_NAME } from "../lib/auth.mjs";
import { createBusinessRegistry, businessFromConfig } from "../lib/businesses.mjs";
import { createFakeWa, TEST_CONFIG } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

/** The real production lead, exactly as it exists in Redis today. */
const REAL_LEAD = {
  id: "86942ee4-267d-4b10-8f3e-cfa81cc09ef5",
  callerNumber: "+919505141818",
  name: "Balu",
  area: "Kukatpally",
  problem: "AC not cooling",
  urgency: "today",
  summary: "AC not cooling in Kukatpally; customer needs a technician today.",
  status: "new",
  source: "missed_call_whatsapp",
  emergency: false,
  createdAt: "2026-09-21T14:57:12.661Z",
  updatedAt: "2026-09-21T14:57:14.041Z",
  ownerNotified: false,
  businessId: "default",
};

function deps() {
  const store = createStore(null);
  return {
    store,
    businesses: createBusinessRegistry([businessFromConfig(TEST_CONFIG)]),
    wa: createFakeWa(),
    templates,
    config: { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw") },
  };
}

const form = (fields) => Buffer.from(new URLSearchParams(fields).toString());
const authed = async (d) => `${COOKIE_NAME}=${await createSession(d.store, "default")}`;

test("status and priority are independent fields", () => {
  const lead = createLead({ callerNumber: "+911", fields: { urgency: "today" }, emergency: false });
  assert.equal(lead.status, "new", "status is workflow position");
  assert.equal(lead.priority, "NORMAL", "priority is how fast it needs attention");
  assert.equal(lead.urgency, "today", "urgency keeps the customer's own timing words");
});

test("an emergency lead is created URGENT without touching status", () => {
  const lead = createLead({ callerNumber: "+911", fields: { urgency: "today" }, emergency: true });
  assert.equal(lead.priority, "URGENT");
  assert.equal(lead.status, "new");
});

test("valid transitions are allowed, invalid ones are not", () => {
  assert.equal(canTransition("new", "contacted"), true);
  assert.equal(canTransition("new", "in_progress"), true);
  assert.equal(canTransition("new", "lost"), true);
  assert.equal(canTransition("contacted", "in_progress"), true);
  assert.equal(canTransition("in_progress", "completed"), true);

  assert.equal(canTransition("new", "completed"), false, "a lead cannot skip straight to completed");
  assert.equal(canTransition("completed", "lost"), false);
  assert.equal(canTransition("new", "__evil__"), false);
});

test("a valid status change is persisted with audit timestamps", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  await handleLeadStatus({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id, status: "contacted" }) }, d);

  const lead = await scoped.getLead(REAL_LEAD.id);
  assert.equal(lead.status, "contacted");
  assert.ok(lead.statusChangedAt, "statusChangedAt recorded");
  assert.ok(lead.lastActivityAt, "lastActivityAt recorded");
  assert.notEqual(lead.updatedAt, REAL_LEAD.updatedAt, "updatedAt moved");
});

test("an invalid transition is rejected and changes nothing", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  await handleLeadStatus({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id, status: "completed" }) }, d);

  assert.equal((await scoped.getLead(REAL_LEAD.id)).status, "new", "new -> completed must not land");
});

test("priority can be changed without affecting status", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD, status: "contacted" });
  const cookie = await authed(d);

  await handleLeadPriority({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id, priority: "URGENT" }) }, d);

  const lead = await scoped.getLead(REAL_LEAD.id);
  assert.equal(lead.priority, "URGENT");
  assert.equal(lead.status, "contacted", "priority change must not move the workflow");
});

test("an unknown priority value is rejected", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  await handleLeadPriority({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id, priority: "SUPER_URGENT" }) }, d);
  assert.equal((await scoped.getLead(REAL_LEAD.id)).priority, undefined);
  assert.equal(isValidPriority("SUPER_URGENT"), false);
});

test("a legacy lead with no priority field falls back to its emergency flag", () => {
  assert.equal(leadPriority({ emergency: true }), "URGENT");
  assert.equal(leadPriority({ emergency: false }), "NORMAL");
  assert.equal(leadPriority(REAL_LEAD), "NORMAL", "the real lead maps to NORMAL, not invented");
});

test("notification retry on success flips ownerNotified and creates no new lead", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  await handleRetryNotification({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id }) }, d);

  const leads = await scoped.listLeads();
  assert.equal(leads.length, 1, "retry must never create a lead");
  assert.equal(leads[0].ownerNotified, true);
  assert.equal(leads[0].status, "new", "retry must not change status");
});

test("notification retry on failure leaves ownerNotified false", async () => {
  const d = deps();
  d.wa.sendText = () => Promise.resolve({ ok: false, status: 400, body: { error: { code: 131030 } } });
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  await handleRetryNotification({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id }) }, d);

  assert.equal((await scoped.getLead(REAL_LEAD.id)).ownerNotified, false,
    "a failed retry must never be recorded as delivered");
});

test("notification retry sends exactly one message to the owner", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  await handleRetryNotification({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id }) }, d);

  const toOwner = d.wa.sent.filter((m) => m.to === TEST_CONFIG.MOHAMED_WHATSAPP_NUMBER);
  assert.equal(toOwner.length, 1);
  assert.equal(d.wa.sent.filter((m) => m.to === REAL_LEAD.callerNumber).length, 0,
    "retrying the owner alert must not message the customer");
});

test("retry requires a session", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });

  await handleRetryNotification({ headers: {}, rawBody: form({ id: REAL_LEAD.id }) }, d);

  assert.equal((await scoped.getLead(REAL_LEAD.id)).ownerNotified, false);
  assert.equal(d.wa.sent.length, 0, "no message may be sent without a session");
});

test("another tenant cannot retry, restatus or reprioritise a lead", async () => {
  const store = createStore(null);
  const d = {
    store,
    businesses: createBusinessRegistry([
      { id: "acme", name: "Acme", ownerName: "A", ownerWhatsApp: "+911", phoneNumberId: "1", missedCallApiKey: "a" },
      { id: "bolt", name: "Bolt", ownerName: "B", ownerWhatsApp: "+912", phoneNumberId: "2", missedCallApiKey: "b" },
    ]),
    wa: createFakeWa(), templates,
    config: { ...TEST_CONFIG, DASHBOARD_PASSWORD_HASH: hashPassword("pw") },
  };
  await scopedToBusiness(store, "bolt").saveLead({ ...REAL_LEAD, id: "victim" });
  const acme = `${COOKIE_NAME}=${await createSession(store, "acme")}`;

  await handleLeadStatus({ headers: { cookie: acme }, rawBody: form({ id: "victim", status: "lost" }) }, d);
  await handleLeadPriority({ headers: { cookie: acme }, rawBody: form({ id: "victim", priority: "URGENT" }) }, d);
  await handleRetryNotification({ headers: { cookie: acme }, rawBody: form({ id: "victim" }) }, d);

  const victim = await scopedToBusiness(store, "bolt").getLead("victim");
  assert.equal(victim.status, "new");
  assert.equal(victim.priority, undefined);
  assert.equal(victim.ownerNotified, false);
  assert.equal(d.wa.sent.length, 0, "no cross-tenant action may send anything");
});

test("the real production lead renders and moves through the lifecycle intact", async () => {
  const d = deps();
  const scoped = scopedToBusiness(d.store, "default");
  await scoped.saveLead({ ...REAL_LEAD });
  const cookie = await authed(d);

  const detail = await handleLeadDetail(
    { headers: { cookie }, query: new URLSearchParams({ id: REAL_LEAD.id }) }, d
  );
  assert.match(detail.html, /Balu/);
  assert.match(detail.html, /Kukatpally/);
  assert.match(detail.html, /AC not cooling/);
  assert.match(detail.html, /Retry notification/, "the undelivered lead offers a retry");

  for (const next of ["contacted", "in_progress", "completed"]) {
    await handleLeadStatus({ headers: { cookie }, rawBody: form({ id: REAL_LEAD.id, status: next }) }, d);
  }

  const final = await scoped.getLead(REAL_LEAD.id);
  assert.equal(final.status, "completed");
  assert.equal(final.name, "Balu", "customer information must survive the lifecycle");
  assert.equal(final.area, "Kukatpally");
  assert.equal(final.problem, "AC not cooling");
  assert.equal(final.urgency, "today");
  assert.equal(final.createdAt, REAL_LEAD.createdAt, "createdAt must never be rewritten");
});

test("allowedTransitions drives the buttons actually offered", () => {
  assert.deepEqual(allowedTransitions("new"), ["contacted", "in_progress", "lost"]);
  assert.deepEqual(allowedTransitions("in_progress"), ["completed", "lost"]);
  assert.deepEqual(allowedTransitions("__unknown__"), []);
});
