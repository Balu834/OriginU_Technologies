import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.mjs";
import { businessRecord, businessContext } from "../lib/businesses.mjs";
import { handleInboundMessage } from "../lib/conversation.mjs";
import { verticalFor } from "../lib/verticals.mjs";
import { extractFields, applyAwaitingFallback } from "../lib/extract.mjs";
import { TEST_CONFIG, createFakeWa } from "./helpers.mjs";
import templates from "../templates.json" with { type: "json" };

const CUSTOMER = "+919000000777";
const OWNER = "+919111111111";

function world(industry) {
  const store = createStore(null);
  const wa = createFakeWa();
  const business = businessRecord({ id: "biz", name: "Sandy's Artistry", industry, ownerName: "Sandy", ownerWhatsApp: OWNER });
  const config = { ...TEST_CONFIG, OWNER_NAME: "Sandy", MOHAMED_WHATSAPP_NUMBER: OWNER };
  const say = (text, id) =>
    handleInboundMessage({ from: CUSTOMER, text, messageId: id }, { store, wa, config, templates, context: businessContext(business) });
  const toCustomer = () => wa.sent.filter((s) => s.to === CUSTOMER).map((s) => s.body);
  const toOwner = () => wa.sent.filter((s) => s.to === OWNER).map((s) => s.body);
  return { store, wa, say, toCustomer, toOwner };
}

test("wedding, makeup, photography and catering businesses are the events type", () => {
  for (const industry of ["Makeup artist", "Wedding and events", "Bridal makeup", "Photography", "Caterers", "Decor", "Event planner"]) {
    assert.equal(verticalFor({ industry }), "events", industry);
  }
  for (const industry of ["Electrical", "Plumbing", "AC repair", "", "Clinic"]) {
    assert.equal(verticalFor({ industry }), "services", industry);
  }
});

test("a makeup artist's lead asks for the occasion and date, in the right fields", async () => {
  const w = world("Makeup artist");
  await w.say("Bridal makeup for my sister's wedding", "m1");
  await w.say("14th Feb", "m2");
  await w.say("Kukatpally", "m3");
  const result = await w.say("Priya", "m4");

  assert.ok(result.leadCompleted, "the lead completes after four answers");
  const lead = result.lead;
  assert.equal(lead.problem, "Bridal makeup for my sister's wedding");
  assert.equal(lead.eventDate, "14th Feb");
  assert.equal(lead.area, "Kukatpally");
  assert.equal(lead.name, "Priya");

  const asked = w.toCustomer();
  assert.ok(asked.some((t) => t.includes(templates._conversation_events.ask_date)), "the date was asked");
  assert.ok(!asked.some((t) => /mains|sparking|technician/i.test(t)), "no electrician wording reaches a makeup customer");

  const alert = w.toOwner().at(-1);
  assert.match(alert, /Date: 14th Feb/);
  assert.match(alert, /Need: Bridal makeup/);
  assert.doesNotMatch(alert, /technician|Urgency/);
});

test("the first reply answers the template's question, and a short second part is the area", async () => {
  const w = world("Electrical");
  await w.say("AC not cooling, Kukatpally", "m1");
  const asked = w.toCustomer();
  // Problem and area are both known, so the next question is the name.
  assert.ok(asked[0].includes(templates._conversation.ask_name), `asked: ${asked[0]}`);
});

test("a plumber's first reply is the problem, not a safety alert shifting every field", async () => {
  const w = world("Plumbing");
  await w.say("Kitchen tap is leaking badly", "m1");
  await w.say("Madhapur", "m2");
  await w.say("Suresh", "m3");
  const result = await w.say("Today", "m4");

  assert.ok(result.leadCompleted);
  assert.equal(result.lead.problem, "Kitchen tap is leaking badly");
  assert.equal(result.lead.area, "Madhapur");
  assert.equal(result.lead.name, "Suresh");
  assert.equal(result.lead.urgency, "today");
});

test("events businesses never get the electrical safety message", async () => {
  const w = world("Decor");
  await w.say("Flower decor with fire torches and smoke effects", "m1");
  assert.ok(!w.toCustomer().some((t) => /mains|sparking/i.test(t)));
  assert.equal(w.toOwner().length, 0, "no URGENT alert for a decor enquiry");
});

test("a thank-you after the lead is done does not start a second lead", async () => {
  const w = world("Makeup artist");
  for (const [t, id] of [["Party makeup", "a"], ["next month", "b"], ["Gachibowli", "c"], ["Ravi", "d"]]) await w.say(t, id);
  const sentBefore = w.wa.sent.length;

  const result = await w.say("ok thanks 🙏", "e");
  assert.equal(result.courtesy, true);
  assert.equal(w.wa.sent.length, sentBefore, "nothing sent, no second alert");
  assert.equal((await w.store.listLeads()).length, 1);
});

test("a greeting is not taken as the answer", () => {
  assert.deepEqual(applyAwaitingFallback("hello", "problem", extractFields("hello")), {});
  assert.deepEqual(applyAwaitingFallback("Hi sir", "problem", extractFields("Hi sir")), {});
});

test("dates are picked up as written", () => {
  assert.equal(extractFields("wedding on 12 December 2026").date, "12 December 2026");
  assert.equal(extractFields("its on Dec 5").date, "Dec 5");
  assert.equal(extractFields("event is next month").date, "next month");
  assert.equal(extractFields("15/11").date, "15/11");
});
