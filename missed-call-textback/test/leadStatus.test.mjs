import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, COOKIE_NAME } from "../lib/auth.mjs";
import { filterLeads, dashboardPage } from "../lib/views.mjs";
import { formatOwnerNotification, isValidStatus } from "../lib/leads.mjs";
import { handleLeadStatus, handleDashboard, handleLogin } from "../routes/dashboard.mjs";
import { createTestDeps } from "./helpers.mjs";

const PASSWORD = "correct horse battery staple";

function deps() {
  return createTestDeps({ DASHBOARD_PASSWORD_HASH: hashPassword(PASSWORD) });
}

async function authed(d) {
  const login = await handleLogin(
    { headers: {}, rawBody: Buffer.from(new URLSearchParams({ password: PASSWORD }).toString()) },
    d
  );
  return login.headers["Set-Cookie"].split(";")[0].split("=")[1];
}

function form(fields) {
  return Buffer.from(new URLSearchParams(fields).toString());
}

const LEAD = {
  id: "lead-1", callerNumber: "+919000000001", name: "Ravi", area: "Whitefield",
  problem: "AC not cooling", urgency: "today", summary: "AC not cooling in Whitefield.",
  status: "new", createdAt: new Date().toISOString(),
};

test("a valid status change persists", async () => {
  const d = deps();
  await d.store.saveLead({ ...LEAD });
  const cookie = `${COOKIE_NAME}=${await authed(d)}`;

  const res = await handleLeadStatus(
    { headers: { cookie }, rawBody: form({ id: "lead-1", status: "contacted" }) },
    d
  );

  assert.equal(res.status, 302);
  assert.equal((await d.store.getLead("lead-1")).status, "contacted");
});

test("an unknown status is rejected rather than written through", async () => {
  const d = deps();
  await d.store.saveLead({ ...LEAD });
  const cookie = `${COOKIE_NAME}=${await authed(d)}`;

  await handleLeadStatus(
    { headers: { cookie }, rawBody: form({ id: "lead-1", status: "__hacked__" }) },
    d
  );

  assert.equal((await d.store.getLead("lead-1")).status, "new", "status must be unchanged");
});

test("changing a lead's status requires a session", async () => {
  const d = deps();
  await d.store.saveLead({ ...LEAD });

  const res = await handleLeadStatus(
    { headers: {}, rawBody: form({ id: "lead-1", status: "completed" }) },
    d
  );

  assert.equal(res.status, 302);
  assert.equal((await d.store.getLead("lead-1")).status, "new", "an unauthenticated post must not change data");
});

test("an unknown lead id is handled without throwing", async () => {
  const d = deps();
  const cookie = `${COOKIE_NAME}=${await authed(d)}`;
  const res = await handleLeadStatus(
    { headers: { cookie }, rawBody: form({ id: "does-not-exist", status: "contacted" }) },
    d
  );
  assert.equal(res.status, 302);
});

test("the redirect cannot be turned into an open redirect", async () => {
  const d = deps();
  await d.store.saveLead({ ...LEAD });
  const cookie = `${COOKIE_NAME}=${await authed(d)}`;

  const res = await handleLeadStatus(
    { headers: { cookie }, rawBody: form({ id: "lead-1", status: "contacted", back: "https://evil.example/x" }) },
    d
  );

  assert.ok(res.headers.Location.startsWith("/leads"), `refused to leave the site, got ${res.headers.Location}`);
});

test("isValidStatus accepts the real set and nothing else", () => {
  for (const s of ["new", "contacted", "in_progress", "completed", "lost"]) assert.equal(isValidStatus(s), true);
  for (const s of ["", "deleted", "NEW", "__proto__"]) assert.equal(isValidStatus(s), false);
});

test("search matches across name, area, problem and number", () => {
  const leads = [
    { ...LEAD, id: "a", name: "Ravi", area: "Whitefield", problem: "AC not cooling" },
    { ...LEAD, id: "b", name: "Priya", area: "Indiranagar", problem: "fan not working" },
  ];
  assert.deepEqual(filterLeads(leads, { q: "ravi" }).map((l) => l.id), ["a"]);
  assert.deepEqual(filterLeads(leads, { q: "indiranagar" }).map((l) => l.id), ["b"]);
  assert.deepEqual(filterLeads(leads, { q: "fan" }).map((l) => l.id), ["b"]);
  assert.deepEqual(filterLeads(leads, { q: "" }).map((l) => l.id), ["a", "b"]);
});

test("status and urgency filters narrow the list", () => {
  const leads = [
    { ...LEAD, id: "a", status: "new", emergency: false },
    { ...LEAD, id: "b", status: "completed", emergency: false },
    { ...LEAD, id: "c", status: "new", emergency: true },
  ];
  assert.deepEqual(filterLeads(leads, { status: "new" }).map((l) => l.id), ["a", "c"]);
  assert.deepEqual(filterLeads(leads, { urgency: "urgent" }).map((l) => l.id), ["c"]);
  assert.deepEqual(filterLeads(leads, { urgency: "normal" }).map((l) => l.id), ["a", "b"]);
  assert.deepEqual(filterLeads(leads, { status: "new", urgency: "urgent" }).map((l) => l.id), ["c"]);
});

test("filter values from the URL are escaped back into the form", async () => {
  const d = deps();
  await d.store.saveLead({ ...LEAD });
  const cookie = `${COOKIE_NAME}=${await authed(d)}`;

  const res = await handleDashboard(
    { headers: { cookie }, query: new URLSearchParams({ q: '"><script>alert(1)</script>' }) },
    d
  );

  assert.doesNotMatch(res.html, /<script>alert\(1\)<\/script>/);
});

test("the owner notification carries phone plus tap-to-act links", () => {
  const text = formatOwnerNotification({ ...LEAD });
  assert.match(text, /Phone: \+919000000001/);
  assert.match(text, /tel:\+919000000001/);
  assert.match(text, /wa\.me\/919000000001/);
});

test("the dashboard shows status and the next actions", () => {
  const html = dashboardPage([{ ...LEAD, status: "contacted" }]);
  assert.match(html, /Contacted/);
  assert.match(html, /\/leads\/status/);
  assert.match(html, /In progress/);
});
