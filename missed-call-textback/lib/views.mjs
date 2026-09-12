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
    --bg:#f4f1ea; --card:#fffdf8; --ink:#16130f; --muted:#6b6255;
    --line:#e2dbcd; --accent:#a8500c; --accent-ink:#fff;
    --urgent:#a81c1c; --urgent-ink:#fff; --urgent-wash:#fdf0ee;
    --shadow:0 1px 2px rgba(22,19,15,.05), 0 8px 24px -12px rgba(22,19,15,.18);
    --display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#12100d; --card:#1c1914; --ink:#f4efe4; --muted:#9c9384;
      --line:#2f2a22; --accent:#e08b2e; --accent-ink:#1a1409;
      --urgent:#f0756a; --urgent-ink:#2a1108; --urgent-wash:#2a1714;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);
    }
  }
`;

const STYLES = `
  ${TOKENS}
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
    font-size:16px; line-height:1.5; min-height:100vh;
    background-image:radial-gradient(circle at 12% -8%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 55%);
    background-repeat:no-repeat;
  }
  .wrap { max-width:640px; margin:0 auto; padding:24px 18px 64px; }

  /* ---- masthead ---- */
  .masthead { display:flex; align-items:flex-end; justify-content:space-between; gap:16px;
              padding-bottom:14px; margin-bottom:26px; border-bottom:2px solid var(--ink); }
  .masthead h1 { font-family:var(--display); font-size:30px; line-height:1; margin:0;
                 letter-spacing:-.02em; font-weight:600; }
  .tally { font-family:var(--mono); font-size:12px; letter-spacing:.1em; text-transform:uppercase;
           color:var(--muted); margin-top:7px; }
  .tally b { color:var(--accent); font-weight:700; }

  /* ---- lead card ---- */
  .lead { position:relative; background:var(--card); border:1px solid var(--line);
          border-radius:4px; padding:18px 18px 16px 22px; margin-bottom:14px;
          box-shadow:var(--shadow); overflow:hidden;
          animation:rise .5s cubic-bezier(.2,.7,.3,1) both; }
  .lead::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--accent); }
  .lead.urgent { border-color:color-mix(in srgb, var(--urgent) 45%, var(--line)); background:var(--urgent-wash); }
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
  input[type=password]:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  .gate button { width:100%; margin-top:14px; min-height:48px; font-size:15px; font-weight:600;
                 border:0; border-radius:3px; background:var(--accent); color:var(--accent-ink);
                 cursor:pointer; letter-spacing:.02em; }
  .gate button:active { transform:translateY(1px); }
  .error { margin:14px 0 0; padding:10px 12px; background:var(--urgent-wash);
           border-left:3px solid var(--urgent); color:var(--urgent); font-size:14px; border-radius:2px; }

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

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

export function loginPage({ error } = {}) {
  return page("Sign in", `
    <div class="gate">
      <div class="plate">Planet Electrical</div>
      <h1>Leads</h1>
      <p class="sub">Missed calls that turned into conversations.</p>
      <form method="POST" action="/login">
        <label class="field" for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
        <button type="submit">Sign in</button>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      </form>
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

function leadCard(lead) {
  const urgent = Boolean(lead.emergency);
  const raw = String(lead.callerNumber ?? "");
  const digits = dialable(raw);

  return `
    <article class="lead${urgent ? " urgent" : ""}">
      <div class="lead-head">
        <h2>${escapeHtml(lead.name || "Unknown caller")}</h2>
        ${urgent ? '<span class="badge">URGENT</span>' : ""}
      </div>
      <div class="when">${escapeHtml(formatWhen(lead.createdAt))}</div>
      <dl class="facts">
        ${fact("Problem", lead.problem)}
        ${fact("Area", lead.area)}
        ${fact("Urgency", lead.urgency)}
      </dl>
      <div class="actions">
        <a class="btn primary" href="tel:${escapeHtml(digits)}">Call <span class="num">${escapeHtml(raw)}</span></a>
        ${digits ? `<a class="btn" href="https://wa.me/${escapeHtml(digits)}">WhatsApp</a>` : ""}
      </div>
    </article>`;
}

export function dashboardPage(leads) {
  const sorted = [...leads].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const urgentCount = sorted.filter((l) => l.emergency).length;

  const tally = sorted.length
    ? `<b>${sorted.length}</b> lead${sorted.length === 1 ? "" : "s"}${urgentCount ? ` &middot; <b>${urgentCount}</b> urgent` : ""}`
    : "Nothing yet";

  const body = sorted.length
    ? sorted.map(leadCard).join("")
    : `<div class="empty">
         <div class="mark">&#9889;</div>
         <p>No leads yet.<br>They appear here the moment a customer replies.</p>
       </div>`;

  return page("Leads", `
    <div class="masthead">
      <div>
        <h1>Leads</h1>
        <div class="tally">${tally}</div>
      </div>
      <form class="signout" method="POST" action="/logout"><button type="submit">Sign out</button></form>
    </div>
    ${body}`);
}
