/**
 * The public page at "/" — what a prospect sees. Shares the dashboard's
 * palette and type stacks (lib/views.mjs TOKENS) so the pitch and the
 * product look like the same thing.
 *
 * Every claim here is deliberately limited to what the service actually
 * does. No invented statistics, no testimonials, no pricing — a page that
 * oversells is worse than no page, because the demo has to live up to it.
 *
 * CONTACT_* below are placeholders. Fill them in before showing this to
 * anyone; nothing here should publish contact details that weren't given.
 */
import { TOKENS, escapeHtml } from "./views.mjs";

const CONTACT_WHATSAPP = ""; // e.g. "919xxxxxxxxx" — enables the WhatsApp button
const CONTACT_EMAIL = ""; // e.g. "hello@example.com" — enables the email button

const STYLES = `
  ${TOKENS}
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
  body {
    margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
    font-size:17px; line-height:1.6;
    background-image:radial-gradient(circle at 85% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%);
    background-repeat:no-repeat;
  }
  .wrap { max-width:760px; margin:0 auto; padding:0 20px; }

  .plate { font-family:var(--mono); font-size:11px; letter-spacing:.22em; text-transform:uppercase;
           color:var(--accent); }

  /* ---- hero ---- */
  .hero { padding:72px 0 56px; }
  .hero h1 { font-family:var(--display); font-size:clamp(34px,7vw,54px); line-height:1.05;
             letter-spacing:-.025em; margin:16px 0 0; font-weight:600; max-width:15ch; }
  .hero .lede { font-size:clamp(17px,2.4vw,20px); color:var(--muted); margin:20px 0 0; max-width:48ch; }
  .cta-row { display:flex; flex-wrap:wrap; gap:11px; margin-top:32px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:50px; padding:0 24px;
         border-radius:3px; text-decoration:none; font-size:16px; font-weight:600;
         border:1px solid var(--accent); color:var(--accent); background:transparent;
         transition:background .15s ease, color .15s ease, transform .1s ease; }
  .btn.primary { background:var(--accent); color:var(--accent-ink); }
  .btn:active { transform:translateY(1px); }
  @media (hover:hover) { .btn:hover { background:var(--accent); color:var(--accent-ink); } }

  /* ---- sections ---- */
  section { padding:52px 0; border-top:1px solid var(--line); }
  h2 { font-family:var(--display); font-size:clamp(25px,4vw,32px); line-height:1.15; margin:0 0 10px;
       letter-spacing:-.02em; font-weight:600; }
  .sub { color:var(--muted); margin:0 0 30px; max-width:52ch; }

  /* ---- steps ---- */
  ol.steps { list-style:none; counter-reset:s; margin:0; padding:0; }
  ol.steps li { counter-increment:s; position:relative; padding:0 0 26px 54px; }
  ol.steps li::before {
    content:counter(s,decimal-leading-zero); position:absolute; left:0; top:-2px;
    font-family:var(--mono); font-size:12px; font-weight:700; color:var(--accent-ink);
    background:var(--accent); width:32px; height:32px; border-radius:50%;
    display:flex; align-items:center; justify-content:center; letter-spacing:0;
  }
  ol.steps li:not(:last-child)::after {
    content:""; position:absolute; left:15.5px; top:36px; bottom:6px; width:1px; background:var(--line);
  }
  ol.steps h3 { font-size:18px; margin:4px 0 4px; font-weight:600; }
  ol.steps p { margin:0; color:var(--muted); font-size:16px; max-width:50ch; }

  /* ---- the message sample ---- */
  .thread { background:var(--card); border:1px solid var(--line); border-radius:4px;
            padding:18px; box-shadow:var(--shadow); }
  .msg { max-width:82%; padding:10px 14px; border-radius:12px; margin-bottom:9px; font-size:15.5px; line-height:1.45; }
  .msg.them { background:color-mix(in srgb, var(--accent) 10%, var(--bg)); border-bottom-left-radius:3px; }
  .msg.us { background:color-mix(in srgb, var(--accent) 88%, #000); color:var(--accent-ink);
            margin-left:auto; border-bottom-right-radius:3px; }
  .thread .cap { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase;
                 color:var(--muted); margin:14px 0 0; }

  /* ---- points ---- */
  .points { display:grid; gap:2px; background:var(--line); border:1px solid var(--line); border-radius:4px; overflow:hidden; }
  .point { background:var(--card); padding:20px; }
  .point h3 { font-size:16px; margin:0 0 5px; font-weight:600; }
  .point p { margin:0; color:var(--muted); font-size:15.5px; }
  @media (min-width:640px) { .points { grid-template-columns:1fr 1fr; } }

  .urgent-note { border-left:3px solid var(--urgent); background:var(--urgent-wash);
                 padding:16px 18px; border-radius:0 3px 3px 0; }
  .urgent-note h3 { font-size:16px; margin:0 0 5px; font-weight:600; color:var(--urgent); }
  .urgent-note p { margin:0; font-size:15.5px; color:var(--ink); }

  footer { border-top:1px solid var(--line); padding:34px 0 56px; color:var(--muted); font-size:14px; }
  footer a { color:var(--muted); }
  .setup { font-family:var(--mono); font-size:12px; letter-spacing:.04em; color:var(--muted);
           border:1px dashed var(--line); border-radius:3px; padding:12px 14px; margin-top:18px; }

  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } html { scroll-behavior:auto; } }
`;

function ctaButtons() {
  const buttons = [];
  if (CONTACT_WHATSAPP) {
    buttons.push(`<a class="btn primary" href="https://wa.me/${escapeHtml(CONTACT_WHATSAPP)}">Talk on WhatsApp</a>`);
  }
  if (CONTACT_EMAIL) {
    buttons.push(`<a class="btn" href="mailto:${escapeHtml(CONTACT_EMAIL)}">Email us</a>`);
  }
  return buttons.length
    ? `<div class="cta-row">${buttons.join("")}</div>`
    : `<div class="setup">Contact details not set — fill in CONTACT_WHATSAPP / CONTACT_EMAIL in lib/landing.mjs before sharing this page.</div>`;
}

export function landingPage({ businessName = "Planet Electrical" } = {}) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Missed-call textback for trades</title>
<meta name="description" content="When a customer calls and you can't pick up, they get a WhatsApp within seconds. The reply becomes a structured lead on your phone.">
<style>${STYLES}</style>
</head><body>

<div class="wrap">
  <header class="hero">
    <div class="plate">Missed-call textback</div>
    <h1>A missed call is a job going to someone else.</h1>
    <p class="lede">
      You're up a ladder, hands full, phone ringing. By the time you climb down they've
      rung the next name on the list. This answers for you — in seconds, on WhatsApp —
      and hands you the job details before you're back on the ground.
    </p>
    ${ctaButtons()}
  </header>

  <section>
    <h2>How it works</h2>
    <p class="sub">Four steps. Three of them happen without you doing anything.</p>
    <ol class="steps">
      <li>
        <h3>You miss a call</h3>
        <p>Your phone keeps ringing exactly as it does now — no call forwarding, no new handset,
           no change to how you take calls. An automation on the phone just notices the one you missed.</p>
      </li>
      <li>
        <h3>They get a WhatsApp, within seconds</h3>
        <p>While they still remember dialling. One question, no sales pitch: what do you need,
           and where are you?</p>
      </li>
      <li>
        <h3>It asks for whatever's missing</h3>
        <p>They reply in their own words. A short back-and-forth fills in the name, area, problem
           and how soon they need someone — one question at a time, never asking twice for
           something they've already said.</p>
      </li>
      <li>
        <h3>You get the lead</h3>
        <p>Name, area, problem, urgency and a one-line summary, on your own WhatsApp — plus a
           dashboard of every lead, with tap-to-call.</p>
      </li>
    </ol>
  </section>

  <section>
    <h2>What the customer sees</h2>
    <p class="sub">No app to install, no form to fill in. They're already in WhatsApp.</p>
    <div class="thread">
      <div class="msg them">Sorry we missed your call — this is ${escapeHtml(businessName)}. Reply here with
        what you need and your area, and we'll call you straight back.</div>
      <div class="msg us">AC not cooling</div>
      <div class="msg them">Sure. What area are you located in?</div>
      <div class="msg us">Whitefield</div>
      <div class="msg them">Thanks. May I have your name?</div>
      <div class="msg us">Ravi</div>
      <div class="msg them">Thanks Ravi, do you need someone today, or is another day okay?</div>
      <div class="msg us">Need someone today</div>
      <p class="cap">You receive: Ravi · Whitefield · AC not cooling · Today</p>
    </div>
  </section>

  <section>
    <h2>Why it's built this way</h2>
    <div class="points">
      <div class="point">
        <h3>Nothing changes about your phone</h3>
        <p>No call forwarding, no diverts, no new hardware. The number customers already
           have keeps working the way it always has.</p>
      </div>
      <div class="point">
        <h3>The first message doesn't sell</h3>
        <p>One question, no links, no offers. It reads like a person who missed your call,
           because that's the only version people reply to.</p>
      </div>
      <div class="point">
        <h3>The lead comes to you, not a dashboard</h3>
        <p>It arrives on your WhatsApp. You're on a roof — you're not going to open a
           dashboard. The dashboard is there when you want it.</p>
      </div>
      <div class="point">
        <h3>It never guesses at the job</h3>
        <p>It collects what the customer said and passes it on. It doesn't diagnose faults,
           quote prices or invent details you'd have to walk back.</p>
      </div>
    </div>
  </section>

  <section>
    <h2>Emergencies skip the queue</h2>
    <div class="urgent-note">
      <h3>Burning smell, sparking, water near electrics</h3>
      <p>Flagged urgent the moment it's mentioned. The customer gets basic safety guidance
         only — switch off at the mains if it's safe to reach — never a diagnosis or a repair
         instruction. You're alerted straight away, before the rest of the details are collected.</p>
    </div>
  </section>

  <section>
    <h2>See it working</h2>
    <p class="sub">Fastest way to judge it is to be the customer: ring the number, hang up,
       and watch what lands on your phone.</p>
    ${ctaButtons()}
  </section>

  <footer>
    Built by OriginU Technologies. Runs on the WhatsApp Business Platform.
    <a href="/leads">Lead dashboard</a>
  </footer>
</div>

</body></html>`;
}
