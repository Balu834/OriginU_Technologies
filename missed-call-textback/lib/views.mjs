/**
 * Server-rendered dashboard pages. Deliberately no client-side JS and no
 * CDN assets — the whole thing is one HTML response.
 *
 * Every lead field is customer-controlled text that arrived over WhatsApp,
 * so it all goes through escapeHtml before it reaches the page. A customer
 * whose "name" is `<script>...` must render as text, not execute in
 * Mohamed's browser.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLES = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#14171a; --muted:#606a76;
          --line:#e3e7ec; --accent:#1f7a4d; --urgent:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14171a; --card:#1d2125; --ink:#f1f3f5; --muted:#9aa5b1; --line:#2c3238;
            --accent:#4ade80; --urgent:#ff6b5e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width: 760px; margin:0 auto; padding:20px 16px 48px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0; }
  .count { color:var(--muted); font-size:14px; }
  .lead { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
  .lead.urgent { border-color:var(--urgent); border-width:2px; }
  .lead h2 { font-size:17px; margin:0 0 2px; }
  .tel { color:var(--accent); text-decoration:none; font-size:15px; }
  .row { margin-top:8px; font-size:15px; }
  .label { color:var(--muted); display:inline-block; min-width:72px; }
  .badge { display:inline-block; background:var(--urgent); color:#fff; font-size:12px; font-weight:600;
           padding:2px 8px; border-radius:999px; margin-left:8px; vertical-align:middle; }
  .when { color:var(--muted); font-size:13px; margin-top:10px; }
  .empty { background:var(--card); border:1px dashed var(--line); border-radius:12px; padding:32px 16px;
           text-align:center; color:var(--muted); }
  form.login { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; max-width:360px; margin:12vh auto 0; }
  label.field { display:block; font-size:14px; color:var(--muted); margin-bottom:6px; }
  input[type=password] { width:100%; padding:12px; font-size:16px; border:1px solid var(--line);
                         border-radius:8px; background:var(--bg); color:var(--ink); }
  button { width:100%; margin-top:12px; padding:12px; font-size:16px; font-weight:600; border:0;
           border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .error { color:var(--urgent); font-size:14px; margin-top:10px; }
  .logout { font-size:14px; color:var(--muted); text-decoration:none; }
  .logout button { width:auto; margin:0; padding:6px 12px; font-size:14px; background:transparent;
                   color:var(--muted); border:1px solid var(--line); }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

export function loginPage({ error } = {}) {
  return page("Sign in", `
    <form class="login" method="POST" action="/login">
      <h1>Leads</h1>
      <label class="field" for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Sign in</button>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    </form>`);
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function leadCard(lead) {
  const urgent = Boolean(lead.emergency);
  const tel = String(lead.callerNumber ?? "");
  return `
    <article class="lead${urgent ? " urgent" : ""}">
      <h2>${escapeHtml(lead.name || "Unknown caller")}${urgent ? '<span class="badge">URGENT</span>' : ""}</h2>
      <a class="tel" href="tel:${encodeURIComponent(tel)}">${escapeHtml(tel)}</a>
      <div class="row"><span class="label">Problem</span>${escapeHtml(lead.problem || "—")}</div>
      <div class="row"><span class="label">Area</span>${escapeHtml(lead.area || "—")}</div>
      <div class="row"><span class="label">Urgency</span>${escapeHtml(lead.urgency || "—")}</div>
      <div class="when">${escapeHtml(formatWhen(lead.createdAt))}</div>
    </article>`;
}

export function dashboardPage(leads) {
  const sorted = [...leads].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const body = sorted.length
    ? sorted.map(leadCard).join("")
    : `<div class="empty">No leads yet.<br>They'll appear here as customers reply.</div>`;

  return page("Leads", `
    <header>
      <div>
        <h1>Leads</h1>
        <div class="count">${sorted.length} total</div>
      </div>
      <form class="logout" method="POST" action="/logout"><button type="submit">Sign out</button></form>
    </header>
    ${body}`);
}
