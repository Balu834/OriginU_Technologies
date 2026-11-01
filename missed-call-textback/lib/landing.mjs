/**
 * The public page at "/" — what a prospect sees before they have an
 * account.
 *
 * Two things about this file are deliberate and worth not undoing.
 *
 * FIRST, THE LINKS. There is no `GET /login` in this application:
 * `/login` is POST-only (see routes/router.mjs), and the sign-in FORM is
 * what `GET /leads` renders when there is no session. So every "Login"
 * on this page points at /leads. Pointing it at /login would 404 for
 * every visitor. "Get Started" points at /signup, which does have a GET.
 *
 * SECOND, THE CLAIMS. Every number and capability here is checked against
 * what the code actually does:
 *   - plan prices and limits come from lib/billing.mjs PLAN_PRICING and
 *     PLAN_ENTITLEMENTS, passed in rather than retyped here
 *   - there is no free TRIAL. FREE is a standing tier, so the page says
 *     "free plan", not "7-day trial"
 *   - PRO is 500 leads a month, so the page does not say "unlimited"
 *   - lead extraction is rule-based (lib/extract.mjs), not a model, so
 *     nothing here calls it AI
 *   - no testimonials, no invented statistics, no logos of customers who
 *     do not exist
 * A page that oversells is worse than no page, because the product has
 * to live up to it on the first call.
 *
 * The palette is defined locally rather than taken from views.mjs TOKENS,
 * so restyling the pitch cannot restyle the signed-in product.
 */
import { escapeHtml } from "./views.mjs";

/** Where the existing auth routes actually live. */
const LOGIN_URL = "/leads"; // GET /login does not exist; this renders the sign-in form
const SIGNUP_URL = "/signup";

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg:#f7faf8; --card:#ffffff; --ink:#0f1714; --muted:#5a6b63;
    --line:#e1eae5; --wash:#eef6f1;
    --accent:#0c7f57; --accent-ink:#ffffff; --accent-soft:#e3f5ec;
    --accent-deep:#0a6b49;
    --shadow-sm:0 1px 2px rgba(15,23,20,.05);
    --shadow:0 1px 3px rgba(15,23,20,.06), 0 16px 40px -18px rgba(15,23,20,.22);
    --shadow-lg:0 2px 6px rgba(15,23,20,.06), 0 24px 48px -20px rgba(15,23,20,.28);
    --radius:16px; --radius-sm:12px;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
    --wrap:1140px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0b100e; --card:#131a17; --ink:#eef4f0; --muted:#8fa39a;
      --line:#1f2a25; --wash:#101815;
      --accent:#2fc98a; --accent-ink:#04150e; --accent-soft:#12281e;
      --accent-deep:#1fa86f;
      --shadow-sm:0 1px 2px rgba(0,0,0,.4);
      --shadow:0 1px 3px rgba(0,0,0,.4), 0 16px 40px -18px rgba(0,0,0,.7);
      --shadow-lg:0 2px 6px rgba(0,0,0,.45), 0 24px 48px -20px rgba(0,0,0,.75);
    }
  }

  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior:auto; }
    * { animation:none !important; transition:none !important; }
  }
  body {
    margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
    font-size:16px; line-height:1.6; -webkit-font-smoothing:antialiased;
    overflow-x:hidden;
  }
  a { color:inherit; }
  img, svg { max-width:100%; }
  .wrap { max-width:var(--wrap); margin:0 auto; padding:0 22px; }
  section { padding:80px 0; }
  h1,h2,h3 { line-height:1.12; letter-spacing:-.025em; margin:0; font-weight:700; }
  h1 { font-size:clamp(34px,5.6vw,56px); letter-spacing:-.035em; }
  h2 { font-size:clamp(26px,3.5vw,38px); }
  h3 { font-size:17px; letter-spacing:-.015em; font-weight:650; }
  p { margin:0; }
  .lede { color:var(--muted); font-size:clamp(16px,1.55vw,18.5px); line-height:1.55; }

  .skip {
    position:absolute; left:-9999px; top:0; background:var(--accent); color:var(--accent-ink);
    padding:10px 16px; border-radius:0 0 8px 0; z-index:100; font-weight:600;
  }
  .skip:focus { left:0; }
  :focus-visible { outline:3px solid var(--accent); outline-offset:2px; border-radius:6px; }

  header {
    position:sticky; top:0; z-index:50; background:color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter:saturate(180%) blur(14px); border-bottom:1px solid var(--line);
  }
  .bar { display:flex; align-items:center; gap:16px; height:66px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:750; letter-spacing:-.025em;
           font-size:17.5px; text-decoration:none; margin-right:auto; }
  .brand .mark {
    width:30px; height:30px; border-radius:9px; background:var(--accent); color:var(--accent-ink);
    display:grid; place-items:center; flex:none; box-shadow:0 2px 8px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  nav.links { display:flex; gap:28px; }
  nav.links a { text-decoration:none; color:var(--muted); font-size:14.5px; font-weight:550; }
  nav.links a:hover { color:var(--ink); }
  .actions { display:flex; align-items:center; gap:10px; }

  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:8px;
    min-height:44px; padding:0 20px; border-radius:11px; font-size:15px; font-weight:650;
    text-decoration:none; border:1px solid transparent; cursor:pointer; white-space:nowrap;
    transition:transform .12s ease, background .12s ease, border-color .12s ease, box-shadow .12s ease;
  }
  .btn:active { transform:translateY(1px); }
  .btn-primary {
    background:var(--accent); color:var(--accent-ink);
    box-shadow:0 1px 2px color-mix(in srgb, var(--accent) 25%, transparent),
               0 8px 20px -8px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .btn-primary:hover { background:var(--accent-deep); }
  .btn-ghost { border-color:var(--line); background:var(--card); color:var(--ink); }
  .btn-ghost:hover { border-color:color-mix(in srgb, var(--accent) 40%, var(--line)); color:var(--accent); }
  .btn-lg { min-height:52px; padding:0 28px; font-size:16px; border-radius:12px; }
  .btn-quiet { text-decoration:none; color:var(--ink); font-weight:600; font-size:15px; padding:0 6px; }
  .btn-quiet:hover { color:var(--accent); }

  #nav-toggle { position:absolute; opacity:0; pointer-events:none; }
  .burger { display:none; width:44px; height:44px; border:1px solid var(--line); border-radius:11px;
            background:var(--card); place-items:center; cursor:pointer; flex:none; }
  .burger span, .burger span::before, .burger span::after {
    content:""; display:block; width:17px; height:2px; background:var(--ink); border-radius:2px;
  }
  .burger span::before { transform:translateY(-5px); }
  .burger span::after  { transform:translateY(3px); }
  .mobile-nav { display:none; }

  @media (max-width: 880px) {
    nav.links, .actions .desktop-only { display:none; }
    .burger { display:grid; }
    #nav-toggle:checked ~ .mobile-nav { display:block; }
    .mobile-nav {
      border-top:1px solid var(--line); background:var(--card); padding:12px 22px 20px;
    }
    .mobile-nav a { display:block; padding:13px 0; text-decoration:none; font-weight:550;
                    border-bottom:1px solid var(--line); color:var(--ink); }
    .mobile-nav .btn { width:100%; margin-top:14px; }
  }

  .hero {
    padding:72px 0 64px;
    background:
      radial-gradient(ellipse 80% 60% at 70% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%),
      radial-gradient(ellipse 50% 40% at 10% 20%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 60%);
  }
  .hero-grid { display:grid; grid-template-columns:1.05fr .95fr; gap:56px; align-items:center; }
  @media (max-width: 980px) { .hero-grid { grid-template-columns:1fr; gap:44px; } }
  .badge {
    display:inline-flex; align-items:center; gap:8px; background:var(--accent-soft); color:var(--accent);
    border-radius:999px; padding:7px 14px; font-size:13px; font-weight:650; margin-bottom:24px;
    border:1px solid color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .badge .dot { width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
  h1 .hl { color:var(--accent); }
  .hero p.lede { margin-top:22px; max-width:54ch; }
  .cta-row { display:flex; gap:12px; flex-wrap:wrap; margin-top:32px; }
  .reassure { display:flex; gap:22px; flex-wrap:wrap; margin-top:20px; color:var(--muted); font-size:14px; }
  .reassure span { display:inline-flex; align-items:center; gap:7px; }
  .tick { color:var(--accent); font-weight:700; }

  .mock {
    background:var(--card); border:1px solid var(--line); border-radius:22px;
    box-shadow:var(--shadow-lg); padding:20px; position:relative;
  }
  .mock::before {
    content:""; position:absolute; inset:-1px; border-radius:23px; padding:1px;
    background:linear-gradient(145deg, color-mix(in srgb, var(--accent) 25%, transparent), transparent 40%, color-mix(in srgb, var(--accent) 10%, transparent));
    -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none;
  }
  .mock-head { display:flex; align-items:center; gap:7px; padding-bottom:14px; border-bottom:1px solid var(--line); }
  .mock-head i { width:9px; height:9px; border-radius:50%; background:var(--line); display:block; }
  .mock-head b { margin-left:6px; font-size:11.5px; font-weight:650; color:var(--muted);
                 font-family:var(--mono); letter-spacing:.08em; text-transform:uppercase; }
  .chat { display:flex; flex-direction:column; gap:10px; padding:18px 2px; }
  .bub { max-width:84%; padding:11px 14px; border-radius:16px; font-size:14.5px; line-height:1.45; }
  .bub.sys { align-self:center; max-width:100%; background:transparent; color:var(--muted);
             font-size:11.5px; font-family:var(--mono); letter-spacing:.06em; text-transform:uppercase; padding:4px; }
  .bub.out { align-self:flex-start; background:var(--wash); border:1px solid var(--line);
             border-bottom-left-radius:5px; }
  .bub.in  { align-self:flex-end; background:var(--accent); color:var(--accent-ink);
             border-bottom-right-radius:5px;
             box-shadow:0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent); }
  .leadcard {
    margin-top:14px; border:1px solid var(--line); border-radius:14px;
    background:var(--bg); padding:16px;
    box-shadow:var(--shadow-sm);
  }
  .leadcard .top { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
  .pill { font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.1em;
          text-transform:uppercase; padding:4px 10px; border-radius:999px;
          background:var(--accent-soft); color:var(--accent); }
  .pill.grey { background:var(--line); color:var(--muted); }
  .leadcard dl { display:grid; grid-template-columns:auto 1fr; gap:7px 16px; margin:0; font-size:14px; }
  .leadcard dt { font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase;
                 color:var(--muted); padding-top:3px; }
  .leadcard dd { margin:0; font-weight:500; }

  .strip {
    background:var(--wash); border-top:1px solid var(--line); border-bottom:1px solid var(--line);
    padding:18px 0; font-size:14px; font-weight:600;
  }
  .strip .wrap { display:flex; align-items:center; justify-content:center; gap:10px 18px; flex-wrap:wrap; }
  .strip .arrow { color:var(--accent); font-weight:400; opacity:.7; }

  .head { text-align:center; max-width:640px; margin:0 auto 40px; }
  .head .lede { margin-top:12px; }
  .grid { display:grid; gap:16px; }
  .g3 { grid-template-columns:repeat(3,1fr); }
  .g4 { grid-template-columns:repeat(4,1fr); }
  @media (max-width: 900px) { .g3, .g4 { grid-template-columns:1fr 1fr; } }
  @media (max-width: 560px) { .g3, .g4 { grid-template-columns:1fr; } }

  .card {
    background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
    padding:24px 22px; box-shadow:var(--shadow-sm);
    transition:border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  }
  .card:hover {
    border-color:color-mix(in srgb, var(--accent) 22%, var(--line));
    box-shadow:var(--shadow);
    transform:translateY(-2px);
  }
  .card .ico {
    width:40px; height:40px; border-radius:11px; background:var(--accent-soft); color:var(--accent);
    display:grid; place-items:center; margin-bottom:14px;
  }
  .card h3 { margin-bottom:8px; }
  .card p { color:var(--muted); font-size:14.5px; line-height:1.5; }
  .card .num {
    font-family:var(--mono); font-size:12px; font-weight:700; letter-spacing:.1em;
    color:var(--accent); margin-bottom:10px;
  }

  .dash {
    background:var(--card); border:1px solid var(--line); border-radius:20px;
    box-shadow:var(--shadow-lg); overflow:hidden; max-width:720px; margin:0 auto;
  }
  .dash-bar { padding:16px 18px; border-bottom:1px solid var(--line); }
  .fake-search {
    background:var(--bg); border:1px solid var(--line); border-radius:10px;
    padding:12px 16px; color:var(--muted); font-size:14px;
  }
  .chips { display:flex; gap:8px; padding:14px 18px; flex-wrap:wrap; border-bottom:1px solid var(--line); }
  .chip {
    font-size:13px; font-weight:600; padding:6px 14px; border-radius:999px;
    border:1px solid var(--line); color:var(--muted); background:var(--card);
  }
  .chip.on { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
  .rows { padding:4px 0; }
  .row {
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    padding:16px 18px; border-bottom:1px solid var(--line);
  }
  .row:last-child { border-bottom:none; }
  .who { font-weight:650; font-size:15.5px; }
  .what { color:var(--muted); font-size:13.5px; margin-top:3px; }
  .meta { text-align:right; font-size:12px; color:var(--muted); }

  .price-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; max-width:780px; margin:0 auto; }
  @media (max-width: 640px) { .price-grid { grid-template-columns:1fr; } }
  .plan {
    background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
    padding:32px 28px; box-shadow:var(--shadow-sm); display:flex; flex-direction:column;
  }
  .plan.featured {
    border-color:var(--accent);
    box-shadow:0 0 0 1px var(--accent), var(--shadow);
    position:relative;
  }
  .plan.featured::after {
    content:"Popular"; position:absolute; top:16px; right:16px;
    font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase;
    background:var(--accent); color:var(--accent-ink); padding:4px 10px; border-radius:999px;
  }
  .plan h3 { font-size:15px; font-weight:650; color:var(--muted); letter-spacing:.02em; text-transform:uppercase; }
  .plan .amount { font-size:36px; font-weight:750; letter-spacing:-.03em; margin:10px 0 4px; }
  .plan .per { color:var(--muted); font-size:14px; margin-bottom:22px; }
  .plan ul { list-style:none; padding:0; margin:0 0 28px; flex:1; }
  .plan li { display:flex; align-items:flex-start; gap:10px; padding:8px 0; font-size:14.5px; }
  .plan .btn { width:100%; }
  .note { text-align:center; color:var(--muted); font-size:14px; margin-top:22px; }

  details.faq {
    background:var(--card); border:1px solid var(--line); border-radius:var(--radius-sm);
    margin-bottom:10px; overflow:hidden;
  }
  details.faq summary {
    list-style:none; cursor:pointer; padding:18px 20px; font-weight:650; font-size:15.5px;
    display:flex; align-items:center; justify-content:space-between; gap:16px;
  }
  details.faq summary::-webkit-details-marker { display:none; }
  details.faq summary::after { content:"+"; color:var(--accent); font-size:22px; font-weight:400; flex:none; line-height:1; }
  details.faq[open] summary::after { content:"\\2212"; }
  details.faq p { padding:0 20px 18px; color:var(--muted); font-size:14.5px; max-width:78ch; line-height:1.55; }

  .final {
    background:
      radial-gradient(ellipse 70% 80% at 50% 100%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%),
      var(--wash);
    border-top:1px solid var(--line); border-bottom:1px solid var(--line);
    text-align:center;
  }
  .final .cta-row { justify-content:center; margin-top:28px; }
  .login-strip {
    display:flex; align-items:center; justify-content:space-between; gap:22px;
    background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
    padding:28px 30px; flex-wrap:wrap; box-shadow:var(--shadow-sm);
  }
  footer { padding:48px 0 60px; border-top:1px solid var(--line); }
  .foot { display:flex; justify-content:space-between; gap:32px; flex-wrap:wrap; }
  .foot nav { display:flex; gap:22px; flex-wrap:wrap; }
  .foot a { color:var(--muted); text-decoration:none; font-size:14px; }
  .foot a:hover { color:var(--accent); }
  .fine { color:var(--muted); font-size:13px; margin-top:28px; }
`;

/** A tiny inline icon set, so the page needs no image requests or icon font. */
const icon = {
  logo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.9 7L4 20l1.6-4A8 8 0 1 1 20 11.5Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="m9 12 2 2 4-4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  phone: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h3l2 5-2 1a12 12 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  chat: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.9 7L4 20.5 5.6 16A8 8 0 1 1 21 12Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  list: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  bell: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10.5 20a2 2 0 0 0 3 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  bolt: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  gear: `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

const tick = `<span class="tick" aria-hidden="true">✓</span>`;

const card = (ic, title, body) => `
  <article class="card">
    <div class="ico">${ic}</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
  </article>`;

const step = (n, ic, title, body) => `
  <article class="card">
    <div class="num">${escapeHtml(n)}</div>
    <div class="ico">${ic}</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
  </article>`;

const faq = (q, a) => `
  <details class="faq">
    <summary>${escapeHtml(q)}</summary>
    <p>${escapeHtml(a)}</p>
  </details>`;

/**
 * @param plans  Real plan data, so prices and limits cannot drift from
 *               lib/billing.mjs by being retyped here.
 */
export function landingPage({ businessName = "", plans = null } = {}) {
  const free = plans?.FREE ?? { price: "Free", leads: 25, messages: 250 };
  const pro = plans?.PRO ?? { price: "₹299 / month", leads: 500, messages: 5000 };
  // The card is already headed "Free"; repeating it as the amount reads like a typo.
  const freeAmount = /^free$/i.test(String(free.price).trim()) ? "₹0" : free.price;
  const count = (n) => Number(n).toLocaleString("en-IN");

  const navLinks = [
    ["#how", "How It Works"],
    ["#features", "Features"],
    ["#pricing", "Pricing"],
    ["#faq", "FAQ"],
  ];

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>MissedCall — turn missed calls into WhatsApp leads</title>
<meta name="description" content="When you can't answer a customer's call, MissedCall automatically follows up on WhatsApp, collects what they need, and turns the conversation into a lead in your dashboard.">
<meta property="og:title" content="MissedCall — turn missed calls into WhatsApp leads">
<meta property="og:description" content="Automatically follow up missed customer calls on WhatsApp and capture the lead.">
<meta property="og:type" content="website">
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header>
  <input type="checkbox" id="nav-toggle" aria-label="Open navigation menu">
  <div class="wrap bar">
    <a class="brand" href="/">
      <span class="mark" aria-hidden="true">${icon.logo}</span>
      MissedCall
    </a>
    <nav class="links" aria-label="Primary">
      ${navLinks.map(([href, label]) => `<a href="${href}">${escapeHtml(label)}</a>`).join("")}
    </nav>
    <div class="actions">
      <a class="btn-quiet desktop-only" href="${LOGIN_URL}">Login</a>
      <a class="btn btn-primary desktop-only" href="${SIGNUP_URL}">Get Started</a>
      <label class="burger" for="nav-toggle" aria-label="Toggle navigation menu"><span></span></label>
    </div>
  </div>
  <div class="mobile-nav">
    <nav aria-label="Mobile">
      ${navLinks.map(([href, label]) => `<a href="${href}">${escapeHtml(label)}</a>`).join("")}
      <a href="${LOGIN_URL}">Login</a>
    </nav>
    <a class="btn btn-primary" href="${SIGNUP_URL}">Get Started</a>
  </div>
</header>

<main id="main">

  <section class="hero">
    <div class="wrap hero-grid">
      <div>
        <span class="badge"><span class="dot" aria-hidden="true"></span> Turn missed calls into new customers</span>
        <h1>Never Lose a Customer Because You <span class="hl">Missed Their Call.</span></h1>
        <p class="lede">When you can't answer a customer's call, automatically send them a WhatsApp
           message, collect what they need, and turn the conversation into a lead.</p>
        <div class="cta-row">
          <a class="btn btn-primary btn-lg" href="${SIGNUP_URL}">Get Started Free</a>
          <a class="btn btn-ghost btn-lg" href="#how">See How It Works</a>
        </div>
        <p class="reassure">
          <span>${tick} No credit card required</span>
          <span>${tick} Free plan, ${escapeHtml(String(free.leads))} leads a month</span>
        </p>
      </div>

      <div class="mock" role="img"
           aria-label="Product walkthrough: a missed call triggers a WhatsApp message, the customer replies that their AC is not cooling and gives their area, and a new lead is created.">
        <div class="mock-head"><i></i><i></i><i></i><b>WhatsApp</b></div>
        <div class="chat">
          <div class="bub sys">Missed call · +91 95051 41818</div>
          <div class="bub out">Sorry we missed your call — this is City Electricals. Reply here with what you need and your area.</div>
          <div class="bub in">AC not cooling</div>
          <div class="bub out">Sure. What area are you located in?</div>
          <div class="bub in">Kukatpally</div>
          <div class="bub sys">Lead created</div>
        </div>
        <div class="leadcard">
          <div class="top"><strong>New lead</strong><span class="pill">New</span></div>
          <dl>
            <dt>Name</dt><dd>Balu</dd>
            <dt>Problem</dt><dd>AC not cooling</dd>
            <dt>Area</dt><dd>Kukatpally</dd>
            <dt>Timing</dt><dd>Today</dd>
          </dl>
        </div>
      </div>
    </div>
  </section>

  <div class="strip">
    <div class="wrap">
      <b>Missed call</b><span class="arrow" aria-hidden="true">→</span>
      <b>Automatic WhatsApp</b><span class="arrow" aria-hidden="true">→</span>
      <b>Lead collection</b><span class="arrow" aria-hidden="true">→</span>
      <b>Owner notification</b>
    </div>
  </div>

  <section>
    <div class="wrap">
      <div class="head">
        <h2>Every Missed Call Could Be a Lost Customer</h2>
        <p class="lede">When you're serving customers, driving, working on a job, or simply
           unavailable, calls get missed. Most customers won't keep calling.</p>
      </div>
      <div class="grid g3">
        ${card(icon.phone, "Missed call", "Customer calls while you're unavailable.")}
        ${card(icon.chat, "No follow-up", "The customer doesn't know when you'll respond.")}
        ${card(icon.bolt, "Lost lead", "The customer contacts another business.")}
      </div>
    </div>
  </section>

  <section id="how" style="background:var(--wash);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
    <div class="wrap">
      <div class="head">
        <h2>Your Missed Calls Follow Up Automatically</h2>
        <p class="lede">Four steps, and you only have to do the last one.</p>
      </div>
      <div class="grid g4">
        ${step("01", icon.phone, "Customer calls", "Someone rings your business number.")}
        ${step("02", icon.bolt, "Call is missed", "You're on a job, driving, or already on a call.")}
        ${step("03", icon.chat, "WhatsApp follows up", "They get a message asking what they need and where they are.")}
        ${step("04", icon.list, "Lead appears", "Their answers arrive in your dashboard as a lead.")}
      </div>
    </div>
  </section>

  <section id="features">
    <div class="wrap">
      <div class="head">
        <h2>What You Get</h2>
        <p class="lede">Everything here is what the product does today.</p>
      </div>
      <div class="grid g3">
        ${card(icon.chat, "Automatic WhatsApp follow-up", "Send a WhatsApp message when a customer call is missed.")}
        ${card(icon.gear, "Easy WhatsApp Setup", "Connect your existing WhatsApp Business account securely through Meta. No API credentials to copy and paste.")}
        ${card(icon.list, "Automatic lead collection", "The conversation collects the customer's problem, area, name and how urgent it is.")}
        ${card(icon.list, "Lead dashboard", "See and manage every captured lead in one place.")}
        ${card(icon.bell, "Owner notifications", "Get a WhatsApp message when a new lead is ready.")}
        ${card(icon.phone, "Call and WhatsApp actions", "Contact customers directly from the dashboard.")}
        ${card(icon.gear, "Business settings", "Configure your services, areas, greeting and owner number.")}
      </div>
    </div>
  </section>

  <section style="background:var(--wash);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
    <div class="wrap">
      <div class="head">
        <h2>All Your Leads. One Simple Dashboard.</h2>
        <p class="lede">Search, filter and follow up — on your phone or a laptop.</p>
      </div>
      <div class="dash">
        <div class="dash-bar">
          <div class="fake-search">Search name, area, problem, number</div>
        </div>
        <div class="chips">
          <span class="chip on">All</span><span class="chip">New</span><span class="chip">Contacted</span>
          <span class="chip">In progress</span><span class="chip">Completed</span><span class="chip">Lost</span>
        </div>
        <div class="rows">
          <div class="row">
            <div><div class="who">Balu</div><div class="what">AC not cooling · Kukatpally</div></div>
            <div class="meta"><span class="pill">New</span><br>Today</div>
          </div>
          <div class="row">
            <div><div class="who">Ravi</div><div class="what">Electrical issue · Miyapur</div></div>
            <div class="meta"><span class="pill grey">Contacted</span></div>
          </div>
          <div class="row">
            <div><div class="who">Suresh</div><div class="what">AC servicing · KPHB</div></div>
            <div class="meta"><span class="pill grey">Completed</span></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="head">
        <h2>Built For Businesses That Can't Afford To Miss Leads</h2>
        <p class="lede">Works for local service businesses that receive customer calls.</p>
      </div>
      <div class="grid g3">
        ${["AC repair", "Electricians", "Plumbers", "Appliance repair", "Pest control", "Cleaning services"]
          .map((t) => `<article class="card"><h3>${escapeHtml(t)}</h3></article>`).join("")}
      </div>
    </div>
  </section>

  <section id="pricing" style="background:var(--wash);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
    <div class="wrap">
      <div class="head">
        <h2>Simple Pricing</h2>
        <p class="lede">Start free. Move up when you're capturing more leads than the free plan allows.</p>
      </div>
      <div class="price-grid">
        <div class="plan">
          <h3>Free</h3>
          <div class="amount">${escapeHtml(freeAmount)}</div>
          <div class="per">No card needed</div>
          <ul>
            <li>${tick} Missed-call follow-up</li>
            <li>${tick} WhatsApp automation</li>
            <li>${tick} Lead collection</li>
            <li>${tick} Lead dashboard</li>
            <li>${tick} Up to ${escapeHtml(count(free.leads))} leads a month</li>
          </ul>
          <a class="btn btn-ghost" href="${SIGNUP_URL}">Get Started Free</a>
        </div>
        <div class="plan featured">
          <h3>Pro</h3>
          <div class="amount">${escapeHtml(pro.price)}</div>
          <div class="per">Billed monthly</div>
          <ul>
            <li>${tick} Everything in Free</li>
            <li>${tick} Up to ${escapeHtml(count(pro.leads))} leads a month</li>
            <li>${tick} Up to ${escapeHtml(count(pro.messages))} WhatsApp messages a month</li>
            <li>${tick} Owner notifications</li>
            <li>${tick} Business settings</li>
            <li>${tick} Team members</li>
          </ul>
          <a class="btn btn-primary" href="${SIGNUP_URL}">Get Started</a>
        </div>
      </div>
      <p class="note">Create your account first — you can move to Pro from your billing settings.</p>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="login-strip">
        <div>
          <h3>Already using MissedCall?</h3>
          <p class="lede" style="margin-top:6px">Log in to your dashboard and manage your leads.</p>
        </div>
        <a class="btn btn-ghost btn-lg" href="${LOGIN_URL}">Login</a>
      </div>
    </div>
  </section>

  <section id="faq">
    <div class="wrap" style="max-width:860px">
      <div class="head"><h2>Questions</h2></div>
      ${faq("How does it work?",
        "When a call to your business goes unanswered, we send that caller a WhatsApp message. They reply with what they need, the conversation collects their problem, area, name and timing, and the result appears in your dashboard as a lead.")}
      ${faq("When does the WhatsApp message get sent?",
        "Right after the missed call is reported to us. Repeat calls from the same number within a short window don't trigger a second message, so nobody gets spammed.")}
      ${faq("Can I use my own WhatsApp number?",
        "Yes. Connect your WhatsApp Business account in a few clicks — you sign in with Meta, choose your number, and we confirm the connection with Meta before marking it live. Messages go out from your number, not ours.")}
      ${faq("What information does the system collect?",
        "The customer's problem, their area, their name and how urgent it is, plus the full conversation so you can see exactly what was said. It never quotes prices, diagnoses faults or promises appointment times.")}
      ${faq("Can I manage leads from my phone?",
        "Yes. The dashboard works on a phone, and each lead has call and WhatsApp buttons so you can reach the customer in one tap.")}
      ${faq("How much does it cost?",
        `The free plan covers up to ${free.leads} leads a month. Pro is ${pro.price} and covers up to ${pro.leads} leads a month.`)}
    </div>
  </section>

  <section class="final">
    <div class="wrap">
      <h2>Stop Losing Customers To Missed Calls.</h2>
      <p class="lede" style="margin:16px auto 0; max-width:54ch">Let your missed calls become
         conversations — and your conversations become leads.</p>
      <div class="cta-row">
        <a class="btn btn-primary btn-lg" href="${SIGNUP_URL}">Get Started Free</a>
        <a class="btn btn-ghost btn-lg" href="${LOGIN_URL}">Login</a>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap foot">
    <div>
      <a class="brand" href="/"><span class="mark" aria-hidden="true">${icon.logo}</span> MissedCall</a>
      <p class="lede" style="margin-top:10px;font-size:14px">Turn missed calls into customers.</p>
    </div>
    <nav aria-label="Footer">
      <a href="#how">How It Works</a>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#faq">FAQ</a>
      <a href="${LOGIN_URL}">Login</a>
      <a href="${SIGNUP_URL}">Get Started</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/data-deletion">Data deletion</a>
    </nav>
  </div>
  <div class="wrap"><p class="fine">${escapeHtml(businessName ? `Run by ${businessName}.` : "")} WhatsApp is a trademark of Meta Platforms, Inc.</p></div>
</footer>
</body></html>`;
}
