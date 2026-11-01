/**
 * The signed-in application shell: sidebar, top bar, and the styles every
 * authenticated page shares.
 *
 * NAVIGATION ONLY POINTS AT ROUTES THAT EXIST. The brief for this
 * redesign asked for AI Settings, Notifications, Help, a notification
 * bell and a business switcher. None of those have routes or data behind
 * them, and a sidebar full of dead links is worse than a short one — so
 * they are absent, and the settings they refer to live where the product
 * actually keeps them:
 *
 *   "AI settings"     services, areas and greeting -> Business settings
 *   "Notifications"   the owner WhatsApp number     -> Business settings
 *
 * Logout is a POST form rather than a link, because /logout is POST-only
 * and destroys the session server-side.
 *
 * The drawer is a checkbox, so it opens without JavaScript and is
 * keyboard-operable for free.
 */
import { escapeHtml } from "./views.mjs";

export const SHELL_STYLES = `
  :root {
    color-scheme: light dark;
    --bg:#f7faf8; --card:#ffffff; --ink:#0f1714; --muted:#5a6b63;
    --line:#e1eae5; --wash:#eef6f1;
    --accent:#0c7f57; --accent-ink:#ffffff; --accent-soft:#e3f5ec;
    --urgent:#b3261e; --urgent-soft:#fdecea;
    --shadow-sm:0 1px 2px rgba(17,24,22,.05);
    --shadow:0 1px 3px rgba(17,24,22,.06), 0 10px 28px -18px rgba(17,24,22,.25);
    --radius:12px; --sidebar:248px;
    --urgent-ink:#ffffff; --urgent-wash:#fdecea;
    --display:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0b100e; --card:#131a17; --ink:#eef4f0; --muted:#8fa39a;
      --line:#1f2a25; --wash:#101815; --accent:#2fc98a; --accent-ink:#04150e;
      --accent-soft:#12281e; --urgent:#f2877f; --urgent-soft:#2a1512;
      --urgent-ink:#2a1512; --urgent-wash:#2a1512;
      --shadow-sm:0 1px 2px rgba(0,0,0,.4);
      --shadow:0 1px 3px rgba(0,0,0,.4), 0 10px 28px -18px rgba(0,0,0,.7);
    }
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
         font-size:15.5px; line-height:1.55; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
  a { color:inherit; }
  h1,h2,h3 { margin:0; line-height:1.2; letter-spacing:-.02em; font-weight:650; }
  h1 { font-size:24px; } h2 { font-size:18px; } h3 { font-size:15.5px; }
  p { margin:0; }
  :focus-visible { outline:3px solid var(--accent); outline-offset:2px; border-radius:8px; }
  .skip { position:absolute; left:-9999px; background:var(--accent); color:var(--accent-ink);
          padding:10px 16px; z-index:100; font-weight:600; }
  .skip:focus { left:0; top:0; }
  .muted { color:var(--muted); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }

  /* ---------------- layout ---------------- */
  #drawer { position:absolute; opacity:0; pointer-events:none; }
  .app { display:grid; grid-template-columns:var(--sidebar) 1fr; min-height:100vh; }
  aside {
    background:var(--card); border-right:1px solid var(--line); display:flex; flex-direction:column;
    position:sticky; top:0; height:100vh; overflow-y:auto;
  }
  .brand { display:flex; align-items:center; gap:9px; padding:18px 18px 14px; font-weight:700;
           letter-spacing:-.02em; text-decoration:none; font-size:16px; }
  .brand .mark { width:26px; height:26px; border-radius:7px; background:var(--accent);
                 color:var(--accent-ink); display:grid; place-items:center; flex:none; }
  .biz { margin:0 12px 14px; padding:10px 12px; border:1px solid var(--line); border-radius:10px;
         background:var(--bg); }
  .biz .name { font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .biz .role { font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase;
               color:var(--muted); margin-top:2px; }
  nav.side { padding:0 12px; flex:1; }
  nav.side .grouplabel { font-family:var(--mono); font-size:10px; letter-spacing:.12em;
                         text-transform:uppercase; color:var(--muted); padding:16px 10px 6px; }
  nav.side a { display:flex; align-items:center; gap:11px; padding:9px 10px; border-radius:9px;
               text-decoration:none; font-size:14.5px; color:var(--ink); margin-bottom:2px; }
  nav.side a:hover { background:var(--bg); }
  nav.side a[aria-current="page"] { background:var(--accent-soft); color:var(--accent); font-weight:600; }
  nav.side a svg { flex:none; opacity:.75; }
  nav.side a[aria-current="page"] svg { opacity:1; }
  .sidefoot { border-top:1px solid var(--line); padding:14px 16px; }
  .who { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .avatar { width:32px; height:32px; border-radius:50%; background:var(--accent-soft); color:var(--accent);
            display:grid; place-items:center; font-weight:700; font-size:13px; flex:none; }
  .who .n { font-size:14px; font-weight:600; line-height:1.2; }
  .who .r { font-size:11.5px; color:var(--muted); }
  .logout { width:100%; min-height:38px; border:1px solid var(--line); background:var(--bg);
            color:var(--muted); border-radius:9px; font-size:13.5px; font-weight:600; cursor:pointer; }
  .logout:hover { color:var(--urgent); border-color:var(--urgent); }

  main { min-width:0; }
  .topbar { position:sticky; top:0; z-index:20; background:color-mix(in srgb, var(--bg) 90%, transparent);
            backdrop-filter:saturate(180%) blur(10px); border-bottom:1px solid var(--line);
            display:flex; align-items:center; gap:14px; padding:0 24px; height:60px; }
  .topbar h1 { font-size:19px; }
  .topbar .spacer { margin-left:auto; }
  .burger { display:none; width:40px; height:40px; border:1px solid var(--line); border-radius:9px;
            background:var(--card); place-items:center; cursor:pointer; flex:none; }
  .burger span, .burger span::before, .burger span::after {
    content:""; display:block; width:16px; height:2px; background:var(--ink); border-radius:2px; }
  .burger span::before { transform:translateY(-5px); } .burger span::after { transform:translateY(3px); }
  .content { padding:26px 24px 72px; max-width:1180px; }

  /*
   * Pages that predate the shell wrap their body in .wrap, a 640px column
   * centred with margin:0 auto and carrying its own padding. Inside the
   * shell that column re-centred itself in an area the shell had already
   * padded and left-aligned, so Leads and every settings page floated in
   * the middle of the screen with their heading stranded at the far left,
   * while Overview filled the space properly. Two pages of one product
   * looked like two products.
   *
   * Neutralised here rather than in each page, so the shell owns page
   * geometry in one place. The measure is kept - a form or a lead card
   * stretched across 1180px is unreadable - but it starts where the
   * heading starts. .wrap outside the shell (sign-in, signup, onboarding)
   * is untouched and stays centred, which is right for a page with no
   * sidebar to align to.
   */
  .content > .wrap { max-width:780px; margin:0; padding:0; }

  @media (max-width: 900px) {
    .app { grid-template-columns:1fr; }
    aside { position:fixed; inset:0 auto 0 0; width:min(84vw,300px); z-index:60;
            transform:translateX(-101%); transition:transform .2s ease; height:100dvh; }
    #drawer:checked ~ .app aside { transform:translateX(0); box-shadow:var(--shadow); }
    #drawer:checked ~ .scrim { display:block; }
    .scrim { display:none; position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:55; }
    .burger { display:grid; }
    .topbar { padding:0 16px; } .content { padding:18px 16px 84px; }
  }

  /* ---------------- shared pieces ---------------- */
  .card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
          box-shadow:var(--shadow-sm); padding:18px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:40px;
         padding:0 15px; border-radius:9px; font-size:14.5px; font-weight:600; text-decoration:none;
         border:1px solid transparent; cursor:pointer; white-space:nowrap; }
  .btn-primary { background:var(--accent); color:var(--accent-ink); }
  .btn-primary:hover { background:color-mix(in srgb, var(--accent) 88%, #000); }
  .btn-ghost { border-color:var(--line); background:var(--card); color:var(--ink); }
  .btn-ghost:hover { border-color:var(--accent); color:var(--accent); }
  .btn-sm { min-height:34px; padding:0 11px; font-size:13px; }
  .pill { display:inline-flex; align-items:center; font-family:var(--mono); font-size:10px; font-weight:700;
          letter-spacing:.1em; text-transform:uppercase; padding:4px 9px; border-radius:999px;
          border:1px solid var(--line); color:var(--muted); background:var(--bg); white-space:nowrap; }
  .pill.new { background:var(--accent-soft); color:var(--accent); border-color:transparent; }
  .pill.urgent { background:var(--urgent-soft); color:var(--urgent); border-color:transparent; }
  .pill.ok { background:var(--accent); color:var(--accent-ink); border-color:transparent; }
  .empty { text-align:center; padding:54px 22px; }
  .empty .mark { font-size:26px; margin-bottom:10px; }
  .empty h2 { margin-bottom:8px; }
  .empty p { color:var(--muted); max-width:44ch; margin:0 auto 18px; font-size:14.5px; }
  .stack { display:grid; gap:16px; }
  .rowbetween { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
  input, select, textarea { font-family:inherit; font-size:16px; }
  table { width:100%; border-collapse:collapse; }
`;

const I = {
  logo: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.9 7L4 20l1.6-4A8 8 0 1 1 20 11.5Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="m9 12 2 2 4-4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  grid: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  list: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
  chat: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.9 7L4 20.5 5.6 16A8 8 0 1 1 21 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  shop: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9ZM4 9l1.6-5h12.8L20 9M9.5 13h5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  team: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 19a5.4 5.4 0 0 0-2-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  card: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18" stroke="currentColor" stroke-width="1.8"/></svg>`,
};

/** Nav groups. Every entry here has a real GET route in routes/router.mjs. */
const NAV = [
  ["Overview", [["/dashboard", "Dashboard", I.grid]]],
  ["Leads", [["/leads", "All leads", I.list]]],
  ["Automation", [["/settings/whatsapp", "WhatsApp", I.chat], ["/settings/phone", "Phone setup", I.chat]]],
  ["Business", [["/settings/business", "Business settings", I.shop], ["/settings/team", "Team", I.team]]],
  ["Account", [["/settings/billing", "Billing", I.card]]],
];

const initials = (name) =>
  String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

/**
 * Wraps page content in the shell.
 *
 * `active` is the pathname of the current page, used for aria-current so
 * assistive tech and the highlight agree.
 */
export function appShell({ title, active = "", business = null, actor = null, body = "", actions = "" }) {
  const nav = NAV.map(([group, items]) => `
    <div class="grouplabel">${escapeHtml(group)}</div>
    ${items.map(([href, label, ic]) => `
      <a href="${href}"${href === active ? ' aria-current="page"' : ""}>${ic}${escapeHtml(label)}</a>`).join("")}
  `).join("");

  const ownerName = business?.ownerName || "";
  const role = actor?.role || "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · MissedCall</title>
<style>${SHELL_STYLES}</style>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<input type="checkbox" id="drawer" aria-label="Open navigation">
<label class="scrim" for="drawer" aria-hidden="true"></label>
<div class="app">
  <aside>
    <a class="brand" href="/dashboard"><span class="mark" aria-hidden="true">${I.logo}</span> MissedCall</a>
    ${business ? `<div class="biz">
        <div class="name" title="${escapeHtml(business.name || "")}">${escapeHtml(business.name || "Your business")}</div>
        <div class="role">${escapeHtml(role || "Signed in")}</div>
      </div>` : ""}
    <nav class="side" aria-label="Sections">${nav}</nav>
    <div class="sidefoot">
      ${ownerName ? `<div class="who">
          <span class="avatar" aria-hidden="true">${escapeHtml(initials(ownerName))}</span>
          <span><span class="n">${escapeHtml(ownerName)}</span><br><span class="r">${escapeHtml(role || "")}</span></span>
        </div>` : ""}
      <form method="POST" action="/logout"><button class="logout" type="submit">Log out</button></form>
    </div>
  </aside>

  <main>
    <div class="topbar">
      <label class="burger" for="drawer" aria-label="Toggle navigation"><span></span></label>
      <h1>${escapeHtml(title)}</h1>
      <div class="spacer"></div>
      ${actions}
    </div>
    <div class="content" id="main">${body}</div>
  </main>
</div>
</body></html>`;
}
