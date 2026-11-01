/**
 * Server-rendered dashboard pages. Deliberately no client-side JS and no
 * CDN assets — the whole thing is one HTML response.
 *
 * Every lead field is customer-controlled text that arrived over WhatsApp,
 * so it all goes through escapeHtml before it reaches the page. A customer
 * whose "name" is `<script>...` must render as text, not execute in
 * Mohamed's browser.
 *
 * Design notes: this is read one-handed, on a phone, usually while deciding
 * whether to drive somewhere. So the two things that matter — who to call
 * and how urgent it is — are the two things you can act on without reading
 * a word. Typography is system-stack only; a webfont would mean either a
 * CDN request or a base64 payload on every page load, and neither is worth
 * it on Indian mobile data.
 */
import { appShell, SHELL_STYLES } from "./shell.mjs";
import { googleButtonHtml, GOOGLE_BUTTON_STYLES } from "./googleAuth.mjs";

import { LEAD_STATUSES, STATUS_LABELS, isValidStatus, leadPriority, allowedTransitions } from "./leads.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Shared palette and type stacks — the public landing page imports these so the two surfaces match. */
export const TOKENS = `
  :root {
    color-scheme: light dark;
    --bg:#f6f4ef; --card:#fffdf9; --ink:#14110e; --muted:#6a6258;
    --line:#e5dfd4; --accent:#0c7f57; --accent-ink:#fff;
    --urgent:#c0392b; --urgent-ink:#fff; --urgent-wash:#fdf2f0;
    --shadow:0 1px 2px rgba(20,17,14,.05), 0 10px 28px -14px rgba(20,17,14,.18);
    --display:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#100f0c; --card:#1a1814; --ink:#f3efe6; --muted:#9a9286;
      --line:#2c2820; --accent:#2fc98a; --accent-ink:#06150e;
      --urgent:#e74c3c; --urgent-ink:#2a100c; --urgent-wash:#2a1614;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 28px -14px rgba(0,0,0,.6);
    }
  }
`;

const STYLES = `
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
    font-size:16px; line-height:1.5; min-height:100vh;
    background-image:radial-gradient(circle at 12% -8%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 55%);
    background-repeat:no-repeat;
  }
  .wrap { max-width:680px; margin:0 auto; padding:22px 16px 72px; }

  /* ---- masthead ---- */
  .masthead { display:flex; align-items:flex-end; justify-content:space-between; gap:16px;
              padding-bottom:16px; margin-bottom:22px; border-bottom:2px solid var(--ink); }
  .masthead h1 { font-family:var(--display); font-size:28px; line-height:1.05; margin:0;
                 letter-spacing:-.03em; font-weight:700; }
  .tally { font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase;
           color:var(--muted); margin-top:8px; }
  .tally b { color:var(--accent); font-weight:700; }

  /* ---- lead card ---- */
  .lead { position:relative; background:var(--card); border:1px solid var(--line);
          border-radius:12px; padding:18px 18px 16px 20px; margin-bottom:12px;
          box-shadow:var(--shadow); overflow:hidden;
          animation:rise .45s cubic-bezier(.2,.7,.3,1) both; }
  .lead::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--accent); border-radius:12px 0 0 12px; }
  .lead.urgent { border-color:color-mix(in srgb, var(--urgent) 40%, var(--line)); background:var(--urgent-wash); }
  .lead.urgent::before { background:var(--urgent); }
  .lead:nth-child(1){animation-delay:.02s} .lead:nth-child(2){animation-delay:.06s}
  .lead:nth-child(3){animation-delay:.1s}  .lead:nth-child(4){animation-delay:.14s}
  .lead:nth-child(5){animation-delay:.18s} .lead:nth-child(6){animation-delay:.22s}
  .lead:nth-child(n+7){animation-delay:.26s}
  @keyframes rise { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }

  .lead-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:3px; }
  .lead h2 { font-family:var(--display); font-size:21px; line-height:1.2; margin:0; font-weight:600;
             letter-spacing:-.01em; word-break:break-word; }
  .badge { font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.14em;
           background:var(--urgent); color:var(--urgent-ink); padding:3px 7px; border-radius:2px; white-space:nowrap; }
  .when { font-family:var(--mono); font-size:11px; letter-spacing:.06em; color:var(--muted);
          text-transform:uppercase; margin-bottom:14px; }

  .facts { display:grid; grid-template-columns:auto 1fr; gap:7px 14px; margin:0 0 16px;
           font-size:15px; align-items:baseline; }
  .facts dt { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase;
              color:var(--muted); padding-top:3px; }
  .facts dd { margin:0; word-break:break-word; }
  .facts dd.dim { color:var(--muted); }

  /* ---- actions: the whole point of the page on a phone ---- */
  .actions { display:flex; gap:9px; }
  .btn { flex:1; display:flex; align-items:center; justify-content:center; gap:7px;
         min-height:46px; padding:0 14px; border-radius:3px; text-decoration:none;
         font-size:15px; font-weight:600; letter-spacing:.01em;
         border:1px solid var(--accent); color:var(--accent); background:transparent;
         transition:background .15s ease, color .15s ease, transform .1s ease; }
  .btn.primary { background:var(--accent); color:var(--accent-ink); }
  .btn .num { font-family:var(--mono); font-size:14px; letter-spacing:.02em; }
  .btn:active { transform:translateY(1px); }
  @media (hover:hover) { .btn:hover { background:var(--accent); color:var(--accent-ink); } }
  .lead.urgent .btn { border-color:var(--urgent); color:var(--urgent); }
  .lead.urgent .btn.primary { background:var(--urgent); color:var(--urgent-ink); }
  @media (hover:hover) { .lead.urgent .btn:hover { background:var(--urgent); color:var(--urgent-ink); } }

  /* ---- empty ---- */
  .empty { border:1px dashed var(--line); border-radius:4px; padding:52px 24px; text-align:center; }
  .empty .mark { font-family:var(--display); font-size:40px; color:var(--accent); line-height:1; }
  .empty p { margin:14px 0 0; color:var(--muted); font-size:15px; }
  /* .btn is built to fill a row of actions on a lead card; standing alone
     in an empty state it should size to its own label instead. */
  .empty .btn { display:inline-flex; flex:0 0 auto; padding:0 22px; }

  /* ---- login ---- */
  .gate { max-width:370px; margin:14vh auto 0; }
  .gate .plate { font-family:var(--mono); font-size:11px; letter-spacing:.22em; text-transform:uppercase;
                 color:var(--accent); margin-bottom:10px; }
  .gate h1 { font-family:var(--display); font-size:38px; line-height:1; margin:0 0 6px;
             letter-spacing:-.025em; font-weight:600; }
  .gate .sub { color:var(--muted); font-size:14px; margin:0 0 26px; }
  .gate form { background:var(--card); border:1px solid var(--line); border-radius:4px;
               padding:22px; box-shadow:var(--shadow); }
  label.field { display:block; font-family:var(--mono); font-size:10px; letter-spacing:.14em;
                text-transform:uppercase; color:var(--muted); margin-bottom:8px; }
  input[type=password] { width:100%; padding:13px 14px; font-size:16px; font-family:var(--mono);
                         letter-spacing:.12em; border:1px solid var(--line); border-radius:3px;
                         background:var(--bg); color:var(--ink); }
  input[type=email] { width:100%; padding:13px 14px; font-size:16px; font-family:inherit;
                      border:1px solid var(--line); border-radius:3px; background:var(--bg); color:var(--ink); }
  input[type=password]:focus, input[type=email]:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  .gate button { width:100%; margin-top:14px; min-height:48px; font-size:15px; font-weight:600;
                 border:0; border-radius:3px; background:var(--accent); color:var(--accent-ink);
                 cursor:pointer; letter-spacing:.02em; }
  .gate button:active { transform:translateY(1px); }
  .error { margin:14px 0 0; padding:10px 12px; background:var(--urgent-wash);
           border-left:3px solid var(--urgent); color:var(--urgent); font-size:14px; border-radius:2px; }

  .undelivered { margin:0 0 12px; padding:9px 11px; font-size:13.5px; border-radius:0 3px 3px 0;
                 border-left:3px solid var(--urgent); background:var(--urgent-wash); color:var(--urgent); }

  /* ---- destructive actions + flash ---- */
  .flash { border-left:3px solid var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent);
           padding:11px 14px; border-radius:0 3px 3px 0; font-size:14px; margin-bottom:16px; }
  details.danger { margin-top:28px; border-top:1px solid var(--line); padding-top:16px; }
  details.danger summary { cursor:pointer; font-family:var(--mono); font-size:11px; letter-spacing:.1em;
                           text-transform:uppercase; color:var(--urgent); }
  details.danger p { font-size:14px; margin:12px 0 0; }
  details.danger form { margin-top:14px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  button.destructive { background:var(--urgent); color:var(--urgent-ink); border:0; border-radius:3px;
                       min-height:44px; padding:0 18px; font-size:15px; font-weight:600; cursor:pointer; }
  .cancel { font-size:14px; color:var(--muted); text-decoration:none; }

  /* ---- filters ---- */
  .filters { margin-bottom:20px; }
  .filters input[type=search] { width:100%; padding:11px 13px; font-size:16px; border:1px solid var(--line);
                                border-radius:3px; background:var(--card); color:var(--ink); }
  .filters input[type=search]:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  .filter-row { display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap; }
  .filters select { flex:1; min-width:130px; padding:9px 10px; font-size:14px; border:1px solid var(--line);
                    border-radius:3px; background:var(--card); color:var(--ink); }
  .filters button { padding:9px 16px; font-size:14px; font-weight:600; border:0; border-radius:3px;
                    background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  .filters .clear { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
                    color:var(--muted); text-decoration:none; }
  @media (hover:hover) { .filters .clear:hover { color:var(--ink); } }

  /* ---- status ---- */
  .status { font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.12em;
            text-transform:uppercase; padding:3px 7px; border-radius:2px; white-space:nowrap;
            border:1px solid var(--line); color:var(--muted); }
  .status-new { border-color:var(--accent); color:var(--accent); }
  .status-contacted, .status-in_progress { border-color:var(--ink); color:var(--ink); }
  .status-completed { border-color:var(--accent); background:var(--accent); color:var(--accent-ink); }
  .status-lost { opacity:.65; }
  .lead.s-completed, .lead.s-lost { opacity:.72; }

  .statusbar { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:12px;
               padding-top:12px; border-top:1px solid var(--line); }
  .statusbar-label { font-family:var(--mono); font-size:10px; letter-spacing:.12em;
                     text-transform:uppercase; color:var(--muted); }
  .statusbar form { display:inline; }
  .statusbar button { font-family:var(--sans); font-size:13px; padding:6px 12px; min-height:34px;
                      background:transparent; color:var(--muted); border:1px solid var(--line);
                      border-radius:3px; cursor:pointer; }
  @media (hover:hover) { .statusbar button:hover { color:var(--ink); border-color:var(--ink); } }
  .statusbar button:active { transform:translateY(1px); }

  /* ---- transcript ---- */
  h2 { font-family:var(--display); font-size:20px; margin:26px 0 4px; font-weight:600; letter-spacing:-.01em; }
  .note { font-size:13px; color:var(--muted); margin:0 0 12px; }
  .backlink { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
              color:var(--muted); text-decoration:none; white-space:nowrap; }
  @media (hover:hover) { .backlink:hover { color:var(--ink); } }
  .transcript { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
  .bubble { max-width:80%; padding:9px 13px; border-radius:13px; font-size:15px; line-height:1.45; }
  .bubble.in  { align-self:flex-start; background:var(--card); border:1px solid var(--line);
                border-bottom-left-radius:3px; }
  .bubble.out { align-self:flex-end; background:color-mix(in srgb, var(--accent) 88%, #000);
                color:var(--accent-ink); border-bottom-right-radius:3px; }
  .bubble-text { white-space:pre-wrap; word-break:break-word; }
  .bubble-meta { font-family:var(--mono); font-size:10px; letter-spacing:.06em; opacity:.7; margin-top:4px; }
  .owner-alerts { margin-top:8px; }
  .alert-row { display:flex; justify-content:space-between; gap:12px; padding:9px 12px; font-size:13px;
               background:var(--card); border:1px solid var(--line); border-radius:3px; margin-bottom:6px; }
  .alert-when, .alert-status { font-family:var(--mono); font-size:11px; color:var(--muted); }
  .leadlink { text-decoration:none; color:inherit; display:block; }

  /* ---- sign out ---- */
  .signout button { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase;
                    padding:7px 12px; background:transparent; color:var(--muted);
                    border:1px solid var(--line); border-radius:3px; cursor:pointer; }
  @media (hover:hover) { .signout button:hover { color:var(--ink); border-color:var(--ink); } }

  @media (prefers-reduced-motion: reduce) {
    .lead { animation:none; }
    * { transition:none !important; }
  }
`;

/**
 * Signed-in pages render inside the application shell (sidebar, top bar,
 * palette). The page-specific CSS below is injected alongside rather than
 * rewritten, so every existing form, control and class keeps working
 * exactly as it did — this redesign adds chrome around the product, it
 * does not re-implement the product.
 */
function page(title, body, { active = "", business = null, actor = null, actions = "" } = {}) {
  return appShell({
    title, active, business, actor, actions,
    body: `<style>${STYLES}</style><div class="wrap">${body}</div>`,
  });
}

/** Sign-in has no session, so it gets no shell — just a centred card. */
export function barePage(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${SHELL_STYLES}${STYLES}${GOOGLE_BUTTON_STYLES}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

export function loginPage({ error, notice, google = false } = {}) {
  return barePage("Sign in", `
    <div class="gate">
      <div class="plate">MissedCall</div>
      <h1>Leads</h1>
      <p class="sub">Missed calls that turned into conversations.</p>
      <form method="POST" action="/login">
        ${google ? googleButtonHtml() : ""}
        <label class="field" for="email">Email</label>
        <input type="email" id="email" name="email" autocomplete="email" style="margin-bottom:14px">
        <label class="field" for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
        <button type="submit">Sign in</button>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        ${notice ? `<p class="sub" role="status">${escapeHtml(notice)}</p>` : ""}
      </form>
      <p class="sub" style="margin-top:16px"><a href="/forgot-password">Forgot password?</a></p>
      <p class="sub" style="margin-top:8px">No account? <a href="/signup">Create one</a>.</p>
    </div>`);
}

/** Digits only, for tel: and wa.me hrefs — customer text never reaches a URL raw. */
function dialable(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const absolute = d.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  // A relative prefix is what actually gets read; the timestamp is for the record.
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 0 || minutes > 60 * 24) return absolute;
  if (minutes < 1) return `Just now · ${absolute}`;
  if (minutes < 60) return `${minutes} min ago · ${absolute}`;
  return `${Math.floor(minutes / 60)} hr ago · ${absolute}`;
}

function fact(label, value) {
  const text = String(value ?? "").trim();
  return `<dt>${escapeHtml(label)}</dt><dd${text ? "" : ' class="dim"'}>${escapeHtml(text || "Not given")}</dd>`;
}

function leadCard(lead, query) {
  const urgent = leadPriority(lead) === "URGENT";
  const raw = String(lead.callerNumber ?? "");
  const digits = dialable(raw);
  const status = isValidStatus(lead.status) ? lead.status : "new";

  // Round-trips the current filters so acting on a lead doesn't dump the
  // owner back to an unfiltered list.
  const back = new URLSearchParams(query ?? {}).toString();

  const statusButtons = allowedTransitions(status)
    .map(
      (next) => `
      <form method="POST" action="/leads/status">
        <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
        <input type="hidden" name="status" value="${escapeHtml(next)}">
        <input type="hidden" name="back" value="${escapeHtml(back)}">
        <button type="submit">${escapeHtml(STATUS_LABELS[next])}</button>
      </form>`
    )
    .join("");

  return `
    <article class="lead${urgent ? " urgent" : ""} s-${escapeHtml(status)}">
      <div class="lead-head">
        <h2><a class="leadlink" href="/lead?id=${encodeURIComponent(lead.id)}">${escapeHtml(lead.name || "Unknown caller")}</a></h2>
        ${urgent ? '<span class="badge">URGENT</span>' : ""}
        <span class="status status-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status])}</span>
      </div>
      <div class="when">${escapeHtml(formatWhen(lead.createdAt))}</div>
      ${lead.ownerNotified === false
        ? `<p class="undelivered">WhatsApp alert for this lead failed to send — it only exists here.</p>`
        : ""}
      <dl class="facts">
        ${fact("Problem", lead.problem)}
        ${fact("Area", lead.area)}
        ${fact("Urgency", lead.urgency)}
      </dl>
      <div class="actions">
        <a class="btn primary" href="tel:${escapeHtml(digits)}">Call <span class="num">${escapeHtml(raw)}</span></a>
        ${digits ? `<a class="btn" href="https://wa.me/${escapeHtml(digits)}">WhatsApp</a>` : ""}
      </div>
      <div class="statusbar">
        <span class="statusbar-label">Mark</span>
        ${statusButtons}
      </div>
    </article>`;
}

/** Case-insensitive match across the fields an owner would actually search by. */
export function leadMatchesSearch(lead, term) {
  if (!term) return true;
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return [lead.name, lead.area, lead.problem, lead.callerNumber, lead.summary]
    .some((v) => String(v ?? "").toLowerCase().includes(needle));
}

export function filterLeads(leads, { q = "", status = "", urgency = "" } = {}) {
  return leads.filter((lead) => {
    if (!leadMatchesSearch(lead, q)) return false;
    if (status && (lead.status ?? "new") !== status) return false;
    const urgent = leadPriority(lead) === "URGENT";
    if (urgency === "urgent" && !urgent) return false;
    if (urgency === "normal" && urgent) return false;
    return true;
  });
}

/**
 * Lead detail with the full WhatsApp transcript.
 *
 * Owner notifications are shown in a separate section, never inline with
 * the customer exchange — they were sent to the business, not to the
 * customer, and mixing them would misrepresent what the customer saw.
 */
export function leadDetailPage(lead, messages = [], { canDelete = false, role = "", business = null, actor = null } = {}) {
  const raw = String(lead.callerNumber ?? "");
  const digits = dialable(raw);
  const priority = leadPriority(lead);
  const urgent = priority === "URGENT";
  const status = isValidStatus(lead.status) ? lead.status : "new";

  const conversation = messages.filter((m) => m.senderType === "customer" || m.senderType === "assistant");
  const ownerAlerts = messages.filter((m) => m.senderType === "owner");

  const bubble = (m) => {
    const mine = m.senderType === "assistant";
    const when = m.timestamp ? formatWhen(m.timestamp) : "";
    const status = m.deliveryStatus ? ` &middot; ${escapeHtml(m.deliveryStatus)}` : "";
    const body = m.messageType === "text"
      ? escapeHtml(m.text)
      : `<em>[${escapeHtml(m.messageType)} message]</em>`;
    return `<div class="bubble ${mine ? "out" : "in"}">
              <div class="bubble-text">${body}</div>
              <div class="bubble-meta">${escapeHtml(when)}${mine ? status : ""}</div>
            </div>`;
  };

  const transcript = conversation.length
    ? `<div class="transcript">${conversation.map(bubble).join("")}</div>`
    : `<div class="empty">
         <p>No transcript stored for this lead.<br>
            It was captured before message history was recorded.</p>
       </div>`;

  const alerts = ownerAlerts.length
    ? `<section class="owner-alerts">
         <h2>Owner alerts</h2>
         <p class="note">Sent to the business, not to the customer.</p>
         ${ownerAlerts.map((m) => `
           <div class="alert-row">
             <span class="alert-when">${escapeHtml(m.timestamp ? formatWhen(m.timestamp) : "")}</span>
             <span class="alert-status">${escapeHtml(m.deliveryStatus ?? (m.metadata?.accepted === false ? "failed" : "no receipt"))}</span>
           </div>`).join("")}
       </section>`
    : "";

  return page(`${lead.name || "Lead"}`, `
    <div class="masthead">
      <div>
        <h1>${escapeHtml(lead.name || "Unknown caller")}</h1>
        <div class="tally">${escapeHtml(formatWhen(lead.createdAt))}</div>
      </div>
      <a class="backlink" href="/leads">All leads</a>
    </div>

    <article class="lead${urgent ? " urgent" : ""}">
      <div class="lead-head">
        ${urgent ? '<span class="badge">URGENT</span>' : ""}
        <span class="status status-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status])}</span>
      </div>
      ${lead.ownerNotified === false
        ? `<div class="undelivered">
             <p>WhatsApp alert for this lead failed to send — it only exists here.</p>
             <form method="POST" action="/lead/retry-notify">
               <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
               <button type="submit">Retry notification</button>
             </form>
           </div>`
        : ""}
      <dl class="facts">
        ${fact("Phone", raw)}
        ${fact("Problem", lead.problem)}
        ${fact("Area", lead.area)}
        ${fact("Timing", lead.urgency)}
        ${fact("Priority", priority)}
        ${fact("Summary", lead.summary)}
        ${fact("Created", formatWhen(lead.createdAt))}
        ${fact("Updated", formatWhen(lead.updatedAt ?? lead.createdAt))}
        ${lead.lastActivityAt ? fact("Last activity", formatWhen(lead.lastActivityAt)) : ""}
      </dl>
      <div class="actions">
        <a class="btn primary" href="tel:${escapeHtml(digits)}">Call</a>
        ${digits ? `<a class="btn" href="https://wa.me/${escapeHtml(digits)}">WhatsApp</a>` : ""}
      </div>
      <div class="statusbar">
        <span class="statusbar-label">Move to</span>
        ${allowedTransitions(status).map((next) => `
          <form method="POST" action="/leads/status">
            <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
            <input type="hidden" name="status" value="${escapeHtml(next)}">
            <button type="submit">${escapeHtml(STATUS_LABELS[next])}</button>
          </form>`).join("")}
      </div>
      <div class="statusbar">
        <span class="statusbar-label">Priority</span>
        <form method="POST" action="/lead/priority">
          <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
          <input type="hidden" name="priority" value="${priority === "URGENT" ? "NORMAL" : "URGENT"}">
          <button type="submit">Mark ${priority === "URGENT" ? "normal" : "urgent"}</button>
        </form>
      </div>
    </article>

    <section>
      <h2>Conversation</h2>
      ${transcript}
    </section>
    ${alerts}
    ${deleteControl(lead, canDelete, role)}`,
    { active: "/leads", business, actor });
}

/**
 * The delete control.
 *
 * Two steps, and both work without JavaScript: the button is inside a
 * closed <details>, so it cannot be hit by a stray click, and the form
 * carries `confirm=delete` which the server requires. The wording says
 * "permanently" and "cannot be undone" because that is what happens —
 * calling it "archive" would be a lie about a destructive action.
 *
 * It also states what is NOT removed. The customer's own messages are
 * preserved when the data model cannot prove they belong to this lead,
 * and an owner deleting a record for privacy reasons needs to know that
 * rather than discover it later.
 */
function deleteControl(lead, canDelete, role) {
  if (!canDelete) {
    return role
      ? `<p class="sub">Your role (${escapeHtml(role)}) cannot delete leads.</p>`
      : "";
  }
  return `<details class="danger">
      <summary>Delete this lead</summary>
      <p>This permanently removes this lead and the messages recorded against it.
         It cannot be undone.</p>
      <p class="sub">The customer's own replies are kept when they cannot be proven to
         belong only to this lead, so another lead from the same number stays intact.</p>
      <form method="POST" action="/lead/delete">
        <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
        <input type="hidden" name="confirm" value="delete">
        <button type="submit" class="destructive">Delete permanently</button>
        <a class="cancel" href="/leads">Cancel</a>
      </form>
    </details>`;
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

/**
 * `whatsappStatus` is the PERSISTED integration state, or null when the
 * caller didn't resolve one. Null means unknown, and unknown says
 * nothing: the empty state only explains itself with "WhatsApp isn't
 * connected" when something actually looked and found that to be true.
 * Defaulting either way would be this page inventing a connection status,
 * which is the one thing it must never do.
 */
export function dashboardPage(
  leads, query = {}, { deleted = false, business = null, actor = null, whatsappStatus = null } = {}
) {
  const { q = "", status = "", urgency = "" } = query;

  const notice = deleted ? `<div class="flash">Lead deleted.</div>` : "";
  const sorted = [...leads].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const visible = filterLeads(sorted, { q, status, urgency });

  const urgentCount = sorted.filter((l) => leadPriority(l) === "URGENT").length;
  const filtering = Boolean(q || status || urgency);

  // Empty deliberately counts nothing. The old "Nothing yet" ran straight
  // on from the sentence before it ("...from your missed calls. Nothing
  // yet") and then said the same thing again in the empty state two
  // inches below. A count belongs on a page that has something to count.
  const tally = !sorted.length
    ? ""
    : filtering
      ? `<b>${visible.length}</b> of ${sorted.length} shown`
      : `<b>${sorted.length}</b> lead${sorted.length === 1 ? "" : "s"}${urgentCount ? ` &middot; <b>${urgentCount}</b> urgent` : ""}`;

  const controls = sorted.length
    ? `<form class="filters" method="GET" action="/leads">
         <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search name, area, problem, number">
         <div class="filter-row">
           <select name="status">
             ${option("", "All statuses", status)}
             ${LEAD_STATUSES.map((s) => option(s, STATUS_LABELS[s], status)).join("")}
           </select>
           <select name="urgency">
             ${option("", "All urgency", urgency)}
             ${option("urgent", "Urgent only", urgency)}
             ${option("normal", "Non-urgent", urgency)}
           </select>
           <button type="submit">Apply</button>
           ${filtering ? `<a class="clear" href="/leads">Clear</a>` : ""}
         </div>
       </form>`
    : "";

  // An empty list has two different meanings, and saying which is the
  // whole point: nobody has replied yet, or nobody CAN reply because the
  // WhatsApp number was never connected. The second is a problem the
  // owner can fix in one click, and leaving them to guess is how a
  // business concludes the product doesn't work.
  const unconnected = whatsappStatus && whatsappStatus !== "CONNECTED";

  let body;
  if (!sorted.length) {
    body = `<div class="empty">
              <div class="mark">&#9889;</div>
              ${unconnected
                ? `<p>No leads yet, and none can arrive until WhatsApp is connected.<br>
                     That's the last step before your missed calls start following themselves up.</p>
                   <p style="margin-top:18px"><a class="btn primary" href="/settings/whatsapp">Connect WhatsApp with Facebook</a></p>
                   <p class="hint" style="margin-top:10px">Meta owns WhatsApp, so connecting means logging in with Facebook once. It takes about 2 minutes.</p>`
                : `<p>No leads yet.<br>They appear here the moment a customer replies.</p>`}
            </div>`;
  } else if (!visible.length) {
    body = `<div class="empty">
              <div class="mark">&#8709;</div>
              <p>No leads match that.<br><a href="/leads">Clear the filters</a></p>
            </div>`;
  } else {
    body = visible.map((lead) => leadCard(lead, query)).join("");
  }

  // The masthead's own title and sign-out are gone: the shell carries both
  // now, and two sign-out buttons on one page is a trap.
  return page("Leads", `
    <p class="sub" style="margin:0 0 18px">Every customer captured from your missed calls.${tally ? ` ${tally}` : ""}</p>
    ${notice}
    ${controls}
    ${body}`,
    { active: "/leads", business, actor });
}
