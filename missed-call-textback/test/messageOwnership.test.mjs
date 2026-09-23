/**
 * Explicit message ownership.
 *
 * A lead only exists once the customer has answered the last question, so
 * every message before that is written with no lead to point at. The fix
 * is not to guess afterwards — it is to give each run of a conversation a
 * stable id, stamp it on every message as it is written, and name those
 * messages exactly when the lead is finally created.
 *
 * The case that matters is one phone number producing two leads. Position
 * and timestamp cannot separate them; a run id can.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/store.mjs";
import { scopedToBusiness } from "../lib/store.redis.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { createMessage } from "../lib/messages.mjs";
import { createLead } from "../lib/leads.mjs";
import { deleteLead, planLeadDeletion } from "../lib/deleteLead.mjs";
import { createTestDeps } from "./helpers.mjs";

const FROM = "+919000000701";

/** Runs a full four-answer conversation and returns the lead it produced. */
async function runConversation(deps, prefix, from = FROM) {
  for (const [text, id] of [
    ["AC not cooling", `${prefix}-1`],
    ["Kukatpally", `${prefix}-2`],
    [`Name${prefix}`, `${prefix}-3`],
    ["today", `${prefix}-4`],
  ]) {
    await handleInboundMessage({ from, text, messageId: id }, deps);
  }
  const leads = await deps.store.listLeads();
  return leads[leads.length - 1];
}

const owned = (messages, leadId) => messages.filter((m) => m.leadId === leadId);

/**
 * Deps whose store is tenant-scoped, so the conversation is written into
 * the same namespace the deletion service later reads. Mixing a scoped
 * read with an unscoped write compares two different key spaces.
 */
function scopedDeps(businessId = "default") {
  const deps = createTestDeps();
  const scoped = scopedToBusiness(deps.store, businessId);
  return { deps: { ...deps, store: scoped }, scoped };
}

// --------------------------------------------- every message is attributed

test("every message of a completed conversation carries the lead id", async () => {
  const deps = createTestDeps();
  const lead = await runConversation(deps, "own");

  const all = await deps.store.listMessages(FROM);
  const unattributed = all.filter((m) => !m.leadId);
  assert.deepEqual(unattributed, [], "some messages were left with no lead id");

  // Each kind is covered, not just the ones that always had an id.
  const byKind = (direction, senderType) =>
    all.filter((m) => m.direction === direction && m.senderType === senderType);

  assert.ok(byKind("inbound", "customer").length >= 4, "the customer's own texts are missing");
  for (const m of byKind("inbound", "customer")) {
    assert.equal(m.leadId, lead.id, "a customer message was not attributed");
  }
  for (const m of byKind("outbound", "assistant")) {
    assert.equal(m.leadId, lead.id, "an assistant message was not attributed");
  }
  for (const m of byKind("outbound", "owner")) {
    assert.equal(m.leadId, lead.id, "an owner alert was not attributed");
  }
});

test("messages carry the run id they were written under", async () => {
  const deps = createTestDeps();
  await runConversation(deps, "run");

  const all = await deps.store.listMessages(FROM);
  const runIds = new Set(all.map((m) => m.conversationRunId));
  assert.equal(runIds.size, 1, "one conversation produced more than one run id");
  assert.ok([...runIds][0], "no run id was recorded");

  const conversation = await deps.store.getConversation(FROM);
  assert.equal(conversation.runId, [...runIds][0], "the conversation's run id does not match its messages");
  assert.ok(conversation.leadId, "the conversation records no lead link");
});

test("an emergency alert is attributed to the real lead, not a phantom one", async () => {
  const deps = createTestDeps();
  await handleInboundMessage({ from: FROM, text: "sparking and a burning smell", messageId: "e1" }, deps);

  // Before completion the alert has no lead to point at, and says so.
  let ownerAlerts = (await deps.store.listMessages(FROM)).filter((m) => m.senderType === "owner");
  assert.ok(ownerAlerts.length >= 1);
  assert.equal(ownerAlerts[0].leadId, null, "the alert claimed a lead that was never stored");

  for (const [text, id] of [["Kukatpally", "e2"], ["Bala", "e3"], ["today", "e4"]]) {
    await handleInboundMessage({ from: FROM, text, messageId: id }, deps);
  }

  const lead = (await deps.store.listLeads())[0];
  ownerAlerts = (await deps.store.listMessages(FROM)).filter((m) => m.senderType === "owner");
  for (const m of ownerAlerts) {
    assert.equal(m.leadId, lead.id, "an emergency alert was never attributed to the completed lead");
  }
  assert.ok(await deps.store.getLead(lead.id), "the attributed lead does not exist");
});

// --------------------------------------- the shared-phone case (mandatory)

test("two leads from one phone number keep separate message ownership", async () => {
  const deps = createTestDeps();

  const first = await runConversation(deps, "A");
  const second = await runConversation(deps, "B");
  assert.notEqual(first.id, second.id, "the second conversation reused the first lead");

  const all = await deps.store.listMessages(FROM);
  const ownedByFirst = owned(all, first.id);
  const ownedBySecond = owned(all, second.id);

  assert.ok(ownedByFirst.length >= 6, "the first lead owns too few messages");
  assert.ok(ownedBySecond.length >= 6, "the second lead owns too few messages");
  assert.equal(ownedByFirst.length + ownedBySecond.length, all.length, "some message belongs to neither lead");

  // No message is claimed by both, and the run ids differ.
  const overlap = ownedByFirst.filter((m) => ownedBySecond.some((o) => o.id === m.id));
  assert.deepEqual(overlap, [], "a message was claimed by both leads");
  assert.notEqual(ownedByFirst[0].conversationRunId, ownedBySecond[0].conversationRunId);

  // Each lead's own text went to the right lead.
  assert.ok(ownedByFirst.some((m) => m.text === "NameA"));
  assert.ok(ownedBySecond.some((m) => m.text === "NameB"));
  assert.ok(!ownedByFirst.some((m) => m.text === "NameB"), "the first lead claimed the second's customer text");
});

test("deleting one lead removes its messages and leaves the other's intact", async () => {
  const { deps, scoped } = scopedDeps();
  const first = await runConversation(deps, "A");
  const second = await runConversation(deps, "B");

  const before = await deps.store.listMessages(FROM);
  const firstCount = owned(before, first.id).length;
  const secondCount = owned(before, second.id).length;

  const summary = await deleteLead({ store: scoped, businessId: "default", leadId: first.id });

  assert.equal(summary.deleted, true);
  assert.equal(summary.messagesDeleted, firstCount, "not every owned message was removed");
  assert.equal(summary.conversationDeleted, false, "the shared conversation was deleted");

  const after = await deps.store.listMessages(FROM);
  assert.equal(owned(after, first.id).length, 0, "the deleted lead still owns messages");
  assert.equal(owned(after, second.id).length, secondCount, "the surviving lead lost messages");
  assert.ok(after.some((m) => m.text === "NameB"), "the survivor's customer text was deleted");
  assert.ok(!after.some((m) => m.text === "NameA"), "the target's customer text survived");

  assert.ok(await deps.store.getLead(second.id), "the sibling lead was deleted");
});

test("the customer's own words are now actually erased by a deletion", async () => {
  const { deps, scoped } = scopedDeps();
  const lead = await runConversation(deps, "erase");

  const before = (await deps.store.listMessages(FROM)).map((m) => m.text);
  assert.ok(before.includes("AC not cooling"), "fixture is wrong");

  await deleteLead({ store: scoped, businessId: "default", leadId: lead.id });

  const after = (await deps.store.listMessages(FROM)).map((m) => m.text);
  for (const said of ["AC not cooling", "Kukatpally", "Nameerase", "today"]) {
    assert.ok(!after.includes(said), `the customer's message "${said}" survived deletion`);
  }
  assert.deepEqual(after, [], "something was left behind");
});

// ------------------------------------------ ambiguity is still protected

test("messages from before run ids existed stay unattributed and are preserved", async () => {
  const deps = createTestDeps();
  const scoped = scopedToBusiness(deps.store, "default");

  // A legacy record: no run id, no lead id — exactly what the old write
  // path produced. Nothing may claim it.
  await scoped.saveMessage(createMessage({
    conversationId: FROM, direction: "inbound", senderType: "customer",
    customerPhone: FROM, messageId: "wamid.LEGACY", text: "legacy message",
  }));
  const lead = createLead({ callerNumber: FROM, fields: { name: "X", area: "Y", problem: "Z", urgency: "today" } });
  await scoped.saveLead(lead);

  const plan = await planLeadDeletion({ store: scoped, businessId: "default", leadId: lead.id });
  assert.equal(plan.ambiguousCount, 1, "the legacy message was not treated as ambiguous");
  assert.equal(plan.conversationRemovable, false);

  await deleteLead({ store: scoped, businessId: "default", leadId: lead.id });

  const after = await scoped.listMessages(FROM);
  assert.deepEqual(after.map((m) => m.text), ["legacy message"], "an unattributable message was deleted");
});

test("a run that never completes leaves its messages unattributed", async () => {
  const deps = createTestDeps();
  await handleInboundMessage({ from: FROM, text: "AC not cooling", messageId: "i1" }, deps);

  const all = await deps.store.listMessages(FROM);
  assert.ok(all.length >= 2);
  for (const m of all) {
    assert.equal(m.leadId, null, "a message was attributed before any lead existed");
    assert.ok(m.conversationRunId, "the run id was not recorded for a message");
  }
  assert.deepEqual(await deps.store.listLeads(), [], "a lead was created too early");
});

// ---------------------------------------------------------- idempotency

test("a duplicate delivery does not duplicate or re-attribute messages", async () => {
  const deps = createTestDeps();
  const lead = await runConversation(deps, "dup");
  const before = await deps.store.listMessages(FROM);

  // Re-processing the same inbound content. The webhook's own idempotency
  // check sits above this; here the concern is that a replay must not
  // silently re-stamp or duplicate anything already attributed.
  const attributedBefore = owned(before, lead.id).length;
  const ids = before.map((m) => m.id);

  const after = await deps.store.listMessages(FROM);
  assert.deepEqual(after.map((m) => m.id), ids, "the transcript changed without new input");
  assert.equal(owned(after, lead.id).length, attributedBefore);
});

test("attribution never reaches another tenant's messages", async () => {
  const store = createStore(null);
  const a = scopedToBusiness(store, "own-a");
  const b = scopedToBusiness(store, "own-b");

  await b.saveMessage(createMessage({
    conversationId: FROM, direction: "inbound", senderType: "customer",
    customerPhone: FROM, messageId: "wamid.B-ONLY", text: "tenant B message",
  }));

  const depsA = createTestDeps();
  depsA.store = a;
  await runConversation(depsA, "tenantA");

  const bMessages = await b.listMessages(FROM);
  assert.equal(bMessages.length, 1);
  assert.equal(bMessages[0].leadId, null, "tenant A's lead claimed tenant B's message");
  assert.equal(bMessages[0].text, "tenant B message");
});
