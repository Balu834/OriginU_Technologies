/**
 * The Overview page.
 *
 * Every number on it is counted from the tenant's own stored leads at
 * request time. There is no statistics API and none was invented: the
 * counts are a reduce over the same `listLeads()` the dashboard already
 * calls, filtered by the selected range. If a business has no leads the
 * page says so rather than showing zeroes dressed up as insight.
 *
 * The setup checklist reads `onboardingStatus()`, which is real state —
 * profile completeness, configured services, and whether the WhatsApp
 * integration has actually been verified against Meta. Nothing here can
 * report a step complete that the product does not consider complete.
 */
import { escapeHtml } from "./views.mjs";
import { appShell } from "./shell.mjs";
import { STATUS_LABELS, leadPriority } from "./leads.mjs";

export const RANGES = { today: "Today", "7d": "7 days", "30d": "30 days", all: "All time" };

const DAYS = { today: 1, "7d": 7, "30d": 30 };

/** Leads created within the selected window. `all` keeps everything. */
export function leadsInRange(leads, range, now = new Date()) {
  const days = DAYS[range];
  if (!days) return [...leads];
  const cutoff = range === "today"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime()
    : now.getTime() - days * 86400000;
  return leads.filter((l) => {
    const at = Date.parse(l.createdAt ?? "");
    return Number.isFinite(at) && at >= cutoff;
  });
}

/** Counts per status, from real records only. */
export function summarise(leads) {
  const counts = { new: 0, contacted: 0, in_progress: 0, completed: 0, lost: 0 };
  let urgent = 0;
  let undelivered = 0;
  for (const lead of leads) {
    if (counts[lead.status] !== undefined) counts[lead.status]++;
    if (leadPriority(lead) === "URGENT") urgent++;
    if (lead.ownerNotified === false) undelivered++;
  }
  return { counts, urgent, undelivered, total: leads.length };
}

function relative(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const dial = (n) => String(n ?? "").replace(/[^\d]/g, "");

const kpi = (label, value, note, tone = "") => `
  <div class="card kpi${tone ? ` ${tone}` : ""}">
    <div class="klabel">${escapeHtml(label)}</div>
    <div class="kvalue">${value}</div>
    <div class="knote">${escapeHtml(note)}</div>
  </div>`;

function attentionRow(lead) {
  const digits = dial(lead.callerNumber);
  const urgent = leadPriority(lead) === "URGENT";
  return `
  <div class="att">
    <div class="att-main">
      <div class="att-top">
        ${urgent ? `<span class="pill urgent">Urgent</span>` : `<span class="pill new">New</span>`}
        <strong>${escapeHtml(lead.name || "Unnamed")}</strong>
        <span class="muted">${escapeHtml(relative(lead.createdAt))}</span>
      </div>
      <div class="muted">${escapeHtml(lead.problem || "No problem recorded")}${lead.area ? ` · ${escapeHtml(lead.area)}` : ""}</div>
    </div>
    <div class="att-actions">
      ${digits ? `<a class="btn btn-ghost btn-sm" href="tel:${escapeHtml(digits)}" aria-label="Call ${escapeHtml(lead.name || "customer")}">Call</a>
      <a class="btn btn-ghost btn-sm" href="https://wa.me/${escapeHtml(digits)}" aria-label="WhatsApp ${escapeHtml(lead.name || "customer")}">WhatsApp</a>` : ""}
      <a class="btn btn-primary btn-sm" href="/lead?id=${encodeURIComponent(lead.id)}">View</a>
    </div>
  </div>`;
}

function recentRow(lead) {
  const digits = dial(lead.callerNumber);
  return `
  <tr>
    <td><strong>${escapeHtml(lead.name || "Unnamed")}</strong><div class="cell-sub">${escapeHtml(lead.callerNumber || "")}</div></td>
    <td>${escapeHtml(lead.problem || "—")}</td>
    <td>${escapeHtml(lead.area || "—")}</td>
    <td>${escapeHtml(lead.urgency || "—")}</td>
    <td><span class="pill ${lead.status === "new" ? "new" : ""}">${escapeHtml(STATUS_LABELS[lead.status] ?? lead.status ?? "")}</span></td>
    <td class="muted">${escapeHtml(relative(lead.createdAt))}</td>
    <td class="right">
      ${digits ? `<a class="btn btn-ghost btn-sm" href="tel:${escapeHtml(digits)}" aria-label="Call ${escapeHtml(lead.name || "customer")}">Call</a>` : ""}
      <a class="btn btn-ghost btn-sm" href="/lead?id=${encodeURIComponent(lead.id)}">View</a>
    </td>
  </tr>`;
}

function checklist(onboarding) {
  if (!onboarding || onboarding.ONBOARDING_COMPLETE) return "";
  const steps = [
    [onboarding.PROFILE_COMPLETE, "Add your business details", "/settings/business"],
    [onboarding.AI_CONFIGURED, "List your services and areas", "/settings/business"],
    [onboarding.WHATSAPP_CONNECTED, "Connect WhatsApp", "/settings/whatsapp"],
  ];
  const done = steps.filter(([ok]) => ok).length;
  const next = steps.find(([ok]) => !ok);

  return `
  <section class="card setup" aria-labelledby="setup-h">
    <div class="rowbetween">
      <div>
        <h2 id="setup-h">Finish setting up</h2>
        <p class="muted" style="margin-top:4px">${done} of ${steps.length} done — leads can't be captured until WhatsApp is connected.</p>
      </div>
      ${next ? `<a class="btn btn-primary" href="${next[2]}">Continue setup</a>` : ""}
    </div>
    <ul class="steps">
      ${steps.map(([ok, label, href]) => `
        <li class="${ok ? "done" : ""}">
          <span class="tick" aria-hidden="true">${ok ? "●" : "○"}</span>
          <a href="${href}">${escapeHtml(label)}</a>
          <span class="sr">${ok ? "completed" : "not completed"}</span>
        </li>`).join("")}
    </ul>
  </section>`;
}

const EXTRA = `
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
  @media (max-width: 900px) { .kpis { grid-template-columns:repeat(2,1fr); } }
  @media (max-width: 460px) { .kpis { grid-template-columns:1fr; } }
  .kpi .klabel { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .kpi .kvalue { font-size:30px; font-weight:700; letter-spacing:-.03em; margin:6px 0 2px; }
  .kpi .knote { font-size:13px; color:var(--muted); }
  .kpi.hot .kvalue { color:var(--accent); }
  .ranges { display:flex; gap:6px; flex-wrap:wrap; }
  .ranges a { padding:7px 13px; border-radius:999px; border:1px solid var(--line); text-decoration:none;
              font-size:13.5px; color:var(--muted); background:var(--card); }
  .ranges a[aria-current="true"] { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:600; }
  .att { display:flex; gap:14px; align-items:center; padding:14px 0; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .att:last-child { border-bottom:0; }
  .att-main { flex:1; min-width:200px; }
  .att-top { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:3px; }
  .att-actions { display:flex; gap:7px; flex-wrap:wrap; }
  .setup .steps { list-style:none; padding:0; margin:16px 0 0; display:grid; gap:9px; }
  .setup .steps li { display:flex; align-items:center; gap:10px; font-size:14.5px; color:var(--muted); }
  .setup .steps li.done { color:var(--ink); }
  .setup .steps li .tick { color:var(--accent); }
  .setup .steps a { text-decoration:none; }
  .setup .steps a:hover { text-decoration:underline; }
  thead th { text-align:left; font-family:var(--mono); font-size:10px; letter-spacing:.11em;
             text-transform:uppercase; color:var(--muted); font-weight:400; padding:0 10px 10px 0; }
  tbody td { padding:13px 10px 13px 0; border-top:1px solid var(--line); vertical-align:top; font-size:14.5px; }
  td.right { text-align:right; white-space:nowrap; }
  td.right .btn { margin-left:6px; }
  .cell-sub { color:var(--muted); font-size:13px; font-family:var(--mono); }
  @media (max-width: 860px) {
    table, thead, tbody, tr, td { display:block; width:100%; }
    thead { display:none; }
    tbody tr { border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:10px; background:var(--card); }
    tbody td { border:0; padding:3px 0; }
    td.right { text-align:left; margin-top:10px; }
    td.right .btn { margin:0 6px 0 0; }
  }
`;

export function overviewPage({
  business, actor, leads = [], range = "7d", onboarding = null, whatsappStatus = "NOT_CONNECTED",
} = {}) {
  const scoped = leadsInRange(leads, range);
  const s = summarise(scoped);

  const attention = scoped
    .filter((l) => l.status === "new" || leadPriority(l) === "URGENT")
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 5);

  const recent = [...scoped]
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 6);

  const greeting = business?.ownerName ? `Welcome back, ${business.ownerName}` : "Welcome back";

  const body = `
  <style>${EXTRA}</style>
  <div class="stack">
    <div class="rowbetween">
      <div>
        <h2 style="font-size:22px">${escapeHtml(greeting)}</h2>
        <p class="muted" style="margin-top:4px">Here's what's happening with your customer leads.</p>
      </div>
      <nav class="ranges" aria-label="Date range">
        ${Object.entries(RANGES).map(([key, label]) =>
          `<a href="/dashboard?range=${key}"${key === range ? ' aria-current="true"' : ""}>${escapeHtml(label)}</a>`).join("")}
      </nav>
    </div>

    ${whatsappStatus !== "CONNECTED" ? `
      <div class="card" style="border-color:var(--accent)">
        <div class="rowbetween">
          <div>
            <h2>WhatsApp isn't connected yet</h2>
            <p class="muted" style="margin-top:4px">Connect WhatsApp to start capturing missed-call leads.</p>
          </div>
          <a class="btn btn-primary" href="/settings/whatsapp">Connect WhatsApp</a>
        </div>
      </div>` : ""}

    ${checklist(onboarding)}

    <div class="kpis">
      ${kpi("New leads", s.counts.new, "Need attention", s.counts.new ? "hot" : "")}
      ${kpi("Contacted", s.counts.contacted, "Customers contacted")}
      ${kpi("In progress", s.counts.in_progress, "Currently being handled")}
      ${kpi("Completed", s.counts.completed, "Jobs completed")}
    </div>

    ${s.undelivered ? `
      <div class="card" style="border-color:var(--urgent)">
        <strong>${s.undelivered} lead${s.undelivered === 1 ? "" : "s"} you weren't notified about.</strong>
        <p class="muted" style="margin-top:4px">The WhatsApp alert to your number didn't go through. Open the lead to retry it.</p>
      </div>` : ""}

    <section class="card" aria-labelledby="att-h">
      <h2 id="att-h">Needs your attention</h2>
      ${attention.length
        ? attention.map(attentionRow).join("")
        : `<p class="muted" style="margin-top:10px">You're all caught up.</p>`}
    </section>

    <section class="card" aria-labelledby="recent-h">
      <div class="rowbetween" style="margin-bottom:6px">
        <h2 id="recent-h">Recent leads</h2>
        <a class="btn btn-ghost btn-sm" href="/leads">View all leads</a>
      </div>
      ${recent.length ? `
        <table>
          <thead><tr>
            <th scope="col">Customer</th><th scope="col">Problem</th><th scope="col">Area</th>
            <th scope="col">Urgency</th><th scope="col">Status</th><th scope="col">Received</th>
            <th scope="col"><span class="sr">Actions</span></th>
          </tr></thead>
          <tbody>${recent.map(recentRow).join("")}</tbody>
        </table>`
        : `<div class="empty">
             <div class="mark" aria-hidden="true">⚡</div>
             <h2>No leads yet</h2>
             <p>When a customer calls and you miss them, we'll automatically follow up on WhatsApp and capture the lead here.</p>
             ${whatsappStatus !== "CONNECTED" ? `<a class="btn btn-primary" href="/settings/whatsapp">Connect WhatsApp</a>` : ""}
           </div>`}
    </section>
  </div>`;

  return appShell({ title: "Dashboard", active: "/dashboard", business, actor, body });
}
