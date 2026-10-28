/**
 * Signup, onboarding and settings pages.
 *
 * Shares the dashboard's tokens so the whole product reads as one thing.
 * No page here ever receives a credential to render — the settings view
 * is handed `publicView(integration)`, which cannot contain one.
 */
import { escapeHtml } from "./views.mjs";
import { googleButtonHtml, GOOGLE_BUTTON_STYLES } from "./googleAuth.mjs";
import { appShell, SHELL_STYLES } from "./shell.mjs";

const STYLES = `
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
         font-size:16px; line-height:1.5; }
  .wrap { max-width:640px; margin:0 auto; padding:28px 18px 64px; }
  .masthead { display:flex; align-items:flex-end; justify-content:space-between; gap:16px;
              padding-bottom:14px; margin-bottom:24px; border-bottom:2px solid var(--ink); }
  h1 { font-family:var(--display); font-size:28px; margin:0; letter-spacing:-.02em; font-weight:600; }
  .plate { font-family:var(--mono); font-size:11px; letter-spacing:.2em; text-transform:uppercase;
           color:var(--accent); margin-bottom:8px; }
  .sub { color:var(--muted); font-size:14px; margin:6px 0 0; }
  .backlink { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
              color:var(--muted); text-decoration:none; white-space:nowrap; }

  .card { background:var(--card); border:1px solid var(--line); border-radius:4px;
          padding:20px; box-shadow:var(--shadow); margin-bottom:16px; }
  label { display:block; font-family:var(--mono); font-size:10px; letter-spacing:.12em;
          text-transform:uppercase; color:var(--muted); margin:14px 0 6px; }
  label:first-child { margin-top:0; }
  input, select { width:100%; padding:11px 12px; font-size:16px; border:1px solid var(--line);
                  border-radius:3px; background:var(--bg); color:var(--ink); font-family:var(--sans); }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  .hint { font-size:12.5px; color:var(--muted); margin:5px 0 0; }
  .choice-label { font-weight:600; font-size:15px; margin:0 0 6px; }
  .assist-card { margin-top:0; border:2px solid var(--accent); }
  .badge { display:inline-block; font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.12em;
           text-transform:uppercase; padding:3px 8px; border-radius:2px; background:var(--accent); color:var(--accent-ink);
           margin-bottom:8px; }
  details.diy > summary { cursor:pointer; font-weight:600; font-size:15px; list-style:none; }
  details.diy > summary::-webkit-details-marker { display:none; }
  details.diy > summary::before { content:"+ "; color:var(--accent); }
  details.diy[open] > summary::before { content:"− "; }
  details.diy[open] > summary { margin-bottom:10px; }
  .assist-note { margin:0 0 10px; color:var(--accent); }
  .assist-note.bad { color:var(--urgent); }
  button.ghost.connect-alt { margin-top:10px; min-height:40px; }
  button.assist-btn { margin-top:16px; }
  button { margin-top:18px; min-height:46px; padding:0 20px; font-size:15px; font-weight:600;
           border:0; border-radius:3px; background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); min-height:34px;
                 font-size:13px; margin-top:0; padding:0 12px; }
  .full { width:100%; }
  .error { margin:14px 0 0; padding:10px 12px; background:var(--urgent-wash);
           border-left:3px solid var(--urgent); color:var(--urgent); font-size:14px; border-radius:2px; }

  dl.facts { display:grid; grid-template-columns:auto 1fr; gap:8px 14px; margin:0; font-size:15px; }
  dl.facts dt { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase;
                color:var(--muted); padding-top:3px; }
  dl.facts dd { margin:0; word-break:break-word; }
  .state { display:inline-block; font-family:var(--mono); font-size:10px; font-weight:700;
           letter-spacing:.12em; padding:3px 8px; border-radius:2px; border:1px solid var(--line); color:var(--muted); }
  .state.CONNECTED { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
  .state.CONFIGURED { border-color:var(--accent); color:var(--accent); }
  .state.ERROR { background:var(--urgent); color:var(--urgent-ink); border-color:var(--urgent); }
  .notice { border-left:3px solid var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent);
            padding:12px 14px; border-radius:0 3px 3px 0; font-size:14px; margin-bottom:16px; }
  .steps { list-style:none; padding:0; margin:12px 0 0; font-size:14.5px; }
  .steps li { padding:5px 0 5px 24px; position:relative; color:var(--muted); }
  .steps li::before { content:"○"; position:absolute; left:0; color:var(--muted); }
  .steps li.done { color:var(--ink); }
  .steps li.done::before { content:"●"; color:var(--accent); }

  .bar { height:6px; margin-top:6px; background:var(--line); border-radius:3px; overflow:hidden; }
  .bar span { display:block; height:100%; background:var(--accent); }

  .btn-link { display:inline-block; margin-top:18px; min-height:46px; line-height:46px; padding:0 20px;
              font-size:15px; font-weight:600; border-radius:3px; background:var(--accent);
              color:var(--accent-ink); text-decoration:none; }
  .btn-link.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  /* Side by side where there's room, stacked on a phone. */
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .actions form { margin:0; }
  .actions button, .actions .btn-link { margin-top:0; }
  .connected-card { border-color:var(--accent); }
  details.advanced { padding:0; }
  details.advanced > summary { padding:16px 20px; cursor:pointer; font-family:var(--mono); font-size:11px;
                               letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  details.advanced[open] > summary { border-bottom:1px solid var(--line); }
  .advanced-body { padding:18px 20px 20px; }
  .warn { margin:0 0 16px; padding:10px 12px; font-size:13.5px; border-radius:2px;
          border-left:3px solid var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent);
          color:var(--muted); }

  table { width:100%; border-collapse:collapse; font-size:15px; }
  th { text-align:left; font-family:var(--mono); font-size:10px; letter-spacing:.12em;
       text-transform:uppercase; color:var(--muted); padding:0 0 8px; font-weight:400; }
  td { padding:9px 0; border-top:1px solid var(--line); }
`;

/**
 * Settings pages render inside the application shell. The page CSS below
 * is injected alongside it rather than replaced, so every existing form
 * and control keeps working unchanged.
 *
 * `signup` and `onboarding` happen before a business exists, so they pass
 * `bare: true` and get a standalone centred page instead of a sidebar
 * that would have nothing to point at.
 */
function page(title, body, script = "", { active = "", business = null, actor = null, bare = false } = {}) {
  if (bare) {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${SHELL_STYLES}${STYLES}${GOOGLE_BUTTON_STYLES}</style>
</head><body><div class="wrap">${body}</div>${script}</body></html>`;
  }
  return appShell({
    title, active, business, actor,
    body: `<style>${STYLES}</style><div class="wrap">${body}</div>${script}`,
  });
}

/**
 * Embeds a value for client-side JS to read.
 *
 * A `<` inside a JSON string could close the script element early and
 * turn data into markup, so it is escaped. This only ever carries the
 * public, non-secret values the checkout widget needs.
 */
function jsonForScript(value) {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

const errorBlock = (error) => (error ? `<p class="error">${escapeHtml(error)}</p>` : "");

export function signupPage({ error, email = "", google = false } = {}) {
  return page("Create account", `
    <div class="plate">MissedCall</div>
    <h1>Create your account</h1>
    <p class="sub">One account, then you'll set up your business.</p>
    <form class="card" method="POST" action="/signup" style="margin-top:22px">
      ${google ? googleButtonHtml("Sign up with Google") : ""}
      <label for="email">Email</label>
      <input type="email" id="email" name="email" value="${escapeHtml(email)}" autocomplete="email" required>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="new-password" required minlength="10">
      <p class="hint">At least 10 characters.</p>
      <button class="full" type="submit">Create account</button>
      ${errorBlock(error)}
    </form>
    <p class="sub">Already have one? <a href="/leads">Sign in</a>.</p>`, "", { bare: true });
}

export function onboardingPage({ error, values = {} } = {}) {
  // Values typed before a validation error are put back, so a missing owner
  // name doesn't cost the owner every other field.
  const v = (k, fallback = "") => escapeHtml(values[k] ?? fallback);
  return page("Set up your business", `
    <div class="plate">Step 1 of 2</div>
    <h1>Your business</h1>
    <p class="sub">This is what customers see and how leads reach you.</p>
    <form class="card" method="POST" action="/onboarding" style="margin-top:22px">
      <label for="name">Business name</label>
      <input id="name" name="name" required placeholder="Planet Electrical" value="${v("name")}">

      <label for="industry">Industry</label>
      <input id="industry" name="industry" list="industry-options" placeholder="Electrical" value="${v("industry")}">
      <datalist id="industry-options">
        <option value="Electrical"><option value="Plumbing"><option value="AC repair">
        <option value="Wedding and events"><option value="Makeup artist"><option value="Photography">
        <option value="Catering"><option value="Decor">
      </datalist>
      <p class="hint">Sets the questions customers are asked. Wedding, events, makeup, photography, catering and decor businesses are asked for the occasion and date.</p>

      <label for="businessPhone">Business phone</label>
      <input id="businessPhone" name="businessPhone" placeholder="+91…" value="${v("businessPhone")}">

      <label for="ownerName">Owner name</label>
      <input id="ownerName" name="ownerName" required placeholder="Mohamed" value="${v("ownerName")}">
      <p class="hint">Customers are told this person will call them back.</p>

      <label for="ownerWhatsApp">Where should leads be sent?</label>
      <input id="ownerWhatsApp" name="ownerWhatsApp" required inputmode="tel" placeholder="+91… (WhatsApp)" value="${v("ownerWhatsApp")}">
      <p class="hint">New leads arrive here as a WhatsApp message. Use a different number from the one customers call.</p>

      <label for="areas">Areas served</label>
      <input id="areas" name="areas" placeholder="Kukatpally, Madhapur" value="${v("areas")}">
      <p class="hint">Comma separated.</p>

      <label for="services">Services</label>
      <input id="services" name="services" placeholder="AC repair, Wiring" value="${v("services")}">

      <label for="timezone">Timezone</label>
      <input id="timezone" name="timezone" value="${v("timezone", "Asia/Kolkata")}">

      <button class="full" type="submit">Create business</button>
      ${errorBlock(error)}
    </form>`, "", { bare: true });
}

/**
 * The WhatsApp page a business owner actually sees.
 *
 * The brief this was rebuilt from is worth restating, because it is a
 * product decision the markup has to keep: a plumber connecting his
 * WhatsApp must never be asked for a phone number id, an access token, an
 * app secret or a webhook verify token. Those are Meta implementation
 * details, and asking a customer to fetch them from the Meta developer
 * dashboard is not onboarding, it is homework.
 *
 * So the main screen has exactly one control — Connect WhatsApp, which
 * runs Meta's own Embedded Signup — and the six-field form still exists,
 * unchanged, behind "Advanced setup" for the technical administrator who
 * genuinely needs it.
 *
 * Two things this page refuses to do:
 *
 * 1. Fake the button. When this deployment's Meta app is not configured
 *    for Embedded Signup, `signup.available` is false and the page says
 *    so plainly, because a button that opens an empty popup is a worse
 *    answer than an honest sentence.
 * 2. Invent a status. Everything shown comes from the persisted
 *    integration record handed in by the route.
 */
export const ASSIST_TIMES = {
  morning: "Morning (9 AM to 12 PM)",
  afternoon: "Afternoon (12 PM to 4 PM)",
  evening: "Evening (4 PM to 8 PM)",
  anytime: "Any time",
};

/** How the owner wants setup help. Never a phone call: WhatsApp chat, or a visit in Hyderabad. */
export const ASSIST_METHODS = {
  whatsapp: "WhatsApp chat",
  visit: "In person (Hyderabad)",
};

const ASSIST_NOTICES = {
  sent: { ok: true, text: "Request received. We'll message you on WhatsApp at the time you picked to connect your number." },
  bad: { ok: false, text: "That doesn't look like a phone number. Enter it with the country code, like +91 98765 43210." },
  fail: { ok: false, text: "We couldn't save your request. Please try again in a moment." },
};

/**
 * "We'll set it up for you." The first and recommended way to connect: the
 * owner gives the number, how they want help (WhatsApp chat or in person,
 * never a phone call) and a good time; we do the Facebook part and they only
 * share the code WhatsApp texts them. Shows the request once it has been made.
 */
function assistCard({ assist, business }) {
  const request = assist?.request ?? null;
  const notice = ASSIST_NOTICES[assist?.notice] ?? null;
  const when = request?.requestedAt
    ? new Date(request.requestedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
    : "";
  const number = request?.number || business?.businessPhone || "";
  const options = Object.entries(ASSIST_TIMES)
    .map(([value, label]) => `<option value="${value}"${request?.bestTime === value ? " selected" : ""}>${label}</option>`)
    .join("");
  const method = ASSIST_METHODS[request?.method] ? request.method : "whatsapp";
  const methodOptions = Object.entries(ASSIST_METHODS)
    .map(([value, label]) => `<option value="${value}"${method === value ? " selected" : ""}>${label}</option>`)
    .join("");
  const chat = assist?.supportDigits
    ? ` or <a href="https://wa.me/${escapeHtml(assist.supportDigits)}">message us on WhatsApp</a>`
    : "";

  return `
    <div class="card assist-card" id="assist">
      <span class="badge">Easiest · free</span>
      <p class="choice-label">We'll set it up for you</p>
      <p class="hint" style="margin:0 0 12px">
        No Facebook or Meta steps for you. Enter your WhatsApp number and we do the setup, guiding
        you on WhatsApp chat, or in person if you're in Hyderabad. All you do is share the 6-digit
        code WhatsApp sends to your phone, and we explain anything that changes on your phone before
        we switch it on.
      </p>
      ${notice ? `<p class="hint assist-note${notice.ok ? "" : " bad"}" role="status">${notice.ok ? "✓ " : "✕ "}${escapeHtml(notice.text)}</p>` : ""}
      ${request && !notice
        ? `<p class="hint assist-note" role="status">✓ Requested on ${escapeHtml(when)} for ${escapeHtml(request.number)}.
             ${method === "visit" ? "We'll message you on WhatsApp to fix a visit" : "We'll message you on WhatsApp"}: ${escapeHtml((ASSIST_TIMES[request.bestTime] ?? ASSIST_TIMES.anytime).toLowerCase())}.
             Nothing else to do${chat}.</p>`
        : ""}
      <form method="POST" action="/settings/whatsapp/assist">
        <label for="assist-number">WhatsApp number to connect</label>
        <input type="tel" id="assist-number" name="number" value="${escapeHtml(number)}" placeholder="+91 98765 43210" autocomplete="tel" required>
        <label for="assist-method">How would you like help?</label>
        <select id="assist-method" name="method">${methodOptions}</select>
        <label for="assist-time">Best time to reach you</label>
        <select id="assist-time" name="bestTime">${options}</select>
        <button type="submit" class="full assist-btn">${request ? "Update my request" : "Set it up for me"}</button>
      </form>
    </div>`;
}

export function whatsappSettingsPage({
  business, integration, status = "NOT_CONNECTED", onboarding, canManage = false, role = "",
  error, verification = null, failure = null, signup = null, templates = null, testMessage = null,
  assist = null, business: shellBusiness = null, actor = null,
} = {}) {
  const connected = status === "CONNECTED";

  // Embedded Signup tokens expire. An expired one cannot send and cannot be
  // refreshed, so the page has to say so and offer the Connect button again
  // rather than keep showing a green tick over a dead connection.
  const expiresAtMs = Date.parse(integration?.connectionExpiresAt ?? integration?.tokenExpiresAt ?? "");
  const tokenIsExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  const expiryDate = Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString().slice(0, 10) : "";

  const TEMPLATE_STATES = {
    submitted: "Sent to Meta for approval. This usually takes minutes, sometimes up to a day. Missed-call messages start working once Meta approves it.",
    existing: "Already set up in your WhatsApp account.",
    failed: "Could not be created automatically. Contact support and we will set it up for you.",
  };
  const templateLine = TEMPLATE_STATES[integration?.template?.state] ?? "";

  // `status` is the persisted integration state handed in by the route.
  // Nothing on this page infers state from a class name or a rendered
  // string — the markup reflects the record, never the other way round.
  const notice = verification
    ? `<div class="card" style="margin-bottom:12px">
         <p class="hint" style="margin:0">
           ${verification.ok ? "✓ " : "✕ "}${escapeHtml(verification.message)}
         </p>
       </div>`
    : "";

  const testMessageNotice = testMessage
    ? `<div class="card" style="margin-bottom:12px${testMessage.ok ? "" : ";border-color:var(--urgent)"}">
         <p class="hint" style="margin:0">${testMessage.ok ? "✓ " : "✕ "}${escapeHtml(testMessage.message)}</p>
       </div>`
    : "";

  // What the "Create message templates" button just did. Three counts,
  // each said in a sentence; "sent for approval" is never called "ready".
  const plural = (n) => `${n} message template${n === 1 ? "" : "s"}`;
  const templatesNotice = templates
    ? `<div class="card" style="margin-bottom:12px${templates.failed ? ";border-color:var(--urgent)" : ""}">
         <p class="hint" style="margin:0">
           ${[
             templates.submitted ? `✓ ${plural(templates.submitted)} created and sent to Meta for approval.` : "",
             templates.existing ? `${plural(templates.existing)} already in your WhatsApp account.` : "",
             templates.failed ? `✕ ${plural(templates.failed)} could not be created. Try again, or contact support.` : "",
           ].filter(Boolean).join(" ")}
         </p>
       </div>`
    : "";

  // A failed or abandoned Meta flow, arriving back as a ?e= marker. The
  // sentence is one of ours; a raw Graph error never reaches this page.
  const failureNotice = failure
    ? `<div class="card" style="margin-bottom:12px;border-color:var(--urgent)">
         <h2 style="font-family:var(--display);font-size:18px;margin:0 0 4px">WhatsApp connection wasn't completed.</h2>
         <p class="hint" style="margin:0 0 12px">${escapeHtml(failure)}</p>
         <p class="hint" style="margin:0 0 12px">Easiest fix: let us set it up for you. It's free and needs no Facebook steps.</p>
         <div class="actions">
           <a class="btn-link" href="#assist">Set it up for me</a>
           <a class="btn-link ghost" href="/settings/whatsapp">Try again</a>
         </div>
       </div>`
    : "";

  // -------------------------------------------------- the main screen

  const success = `
    <div class="card connected-card">
      <h2 style="font-family:var(--display);font-size:20px;margin:0 0 4px">✓ WhatsApp Connected</h2>
      <p class="hint" style="margin:0 0 16px">Your WhatsApp Business number is ready.</p>
      <dl class="facts">
        <dt>Business</dt><dd>${escapeHtml(business?.name || "—")}</dd>
        <dt>WhatsApp</dt><dd>${escapeHtml(integration?.displayPhoneNumber || "Connected number")}</dd>
        <dt>Status</dt><dd><span class="state CONNECTED">Connected</span></dd>
        ${templateLine ? `<dt>Message template</dt><dd>${escapeHtml(templateLine)}</dd>` : ""}
        ${expiryDate && !tokenIsExpired ? `<dt>Renews by</dt><dd>${escapeHtml(expiryDate)} (renews automatically while you are receiving missed calls)</dd>` : ""}
      </dl>
      ${canManage
        ? `<div class="actions">
             <form method="POST" action="/settings/whatsapp/test">
               <button type="submit">Test Connection</button>
             </form>
             <form method="POST" action="/settings/whatsapp/templates">
               <button type="submit">Create message templates</button>
             </form>
             <a class="btn-link ghost" href="/dashboard">Continue to Dashboard</a>
           </div>
           <p class="hint" style="margin-top:10px">
             Create message templates adds MissedCall's message templates to your WhatsApp
             account if any are missing. Meta reviews a new template before it can be sent.
           </p>
           <form method="POST" action="/settings/whatsapp/send-test" style="margin-top:16px">
             <label class="field" for="test-number">Send a test message</label>
             <div class="actions">
               <input type="tel" id="test-number" name="number" placeholder="+919876543210" autocomplete="off" required style="max-width:240px">
               <button type="submit">Send test message</button>
             </div>
           </form>
           <p class="hint" style="margin-top:10px">
             Sends your missed-call message to this number exactly as a caller receives it.
             It is a real WhatsApp message and counts as one on your plan.
           </p>`
        : `<p class="hint" style="margin-top:14px">Your role (${escapeHtml(role || "STAFF")}) can view this connection but not change it.</p>`}
    </div>`;

  // Not connected. "We'll set it up for you" comes first; the Meta login
  // flow is folded away under "Do it yourself" for owners who want it, with
  // an honest explanation when that button genuinely cannot work yet.
  const connectCard = `
    <div class="card">
      <h2 style="font-family:var(--display);font-size:20px;margin:0 0 4px">Connect your WhatsApp Business account</h2>
      <p class="hint" style="margin:0">
        Automatically follow up with customers when you miss their calls and capture
        new leads through WhatsApp.
      </p>
      ${!canManage ? `<p class="hint" style="margin:12px 0 0">Your role (${escapeHtml(role || "STAFF")}) can view this but not connect WhatsApp.</p>` : ""}
    </div>
    ${canManage ? assistCard({ assist, business }) : ""}
    ${canManage
      ? `<div class="card">
      <details class="diy" id="diy"${error ? " open" : ""}>
      <summary>Do it yourself with Facebook · about 2 minutes</summary>
      ${signup?.available
          ? `<p class="hint" style="margin:0 0 12px">
               A Facebook window opens, because Meta owns WhatsApp and only lets a business connect its
               number after logging in with Facebook.
             </p>
             <p class="hint" style="margin:0 0 8px"><strong>Already use the WhatsApp Business app on this number?</strong>
               Keep it. Log in, then scan the QR code Meta shows using the WhatsApp Business app on your phone.
               Your chats, contacts and number stay as they are, and MissedCall only replies to people who
               gave you a missed call. Update the app first; regular WhatsApp (not Business) can't do this.
             </p>
             <button type="button" id="connect-whatsapp-app" class="full" data-mode="app">Keep my WhatsApp Business app (scan a QR code)</button>
             <button type="button" id="connect-whatsapp" class="full ghost connect-alt" data-mode="api">Use a number that's not on WhatsApp</button>
             <p class="hint" id="connect-status" role="status" aria-live="polite" hidden></p>
             <p class="hint" id="connect-recover" hidden>
               <a href="#assist">Let us set it up for you</a> · <a href="/settings/whatsapp">Try again</a> · <a href="#advanced">Advanced setup</a>
             </p>
             <p class="hint">Securely connect your WhatsApp Business account through Meta.</p>
             <noscript>
               <p class="hint">Connecting through Meta needs JavaScript. Use Advanced setup below instead.</p>
             </noscript>`
          : `<p class="hint" style="margin:0">
               One-click connection isn't switched on for this deployment yet, so there is
               nothing here that could complete a connection. Use Advanced setup below, or
               contact support.
             </p>`}
      ${errorBlock(error)}
      </details>
    </div>`
      : ""}`;

  // A stored-but-unproven or rejected connection. Says which, and what to
  // do about it, without showing anything technical.
  const interim = !connected && integration
    ? `<div class="card">
         <p class="hint" style="margin:0 0 10px">
           ${status === "ERROR"
             ? "Meta didn't accept this connection the last time it was checked."
             : "This connection is saved but hasn't been confirmed by Meta yet."}
         </p>
         ${canManage
           ? `<form method="POST" action="/settings/whatsapp/test" style="display:inline">
                <button type="submit">Test Connection</button>
              </form>`
           : ""}
       </div>`
    : "";

  const expiredCard = tokenIsExpired
    ? `<div class="card" style="margin-bottom:12px;border-color:var(--urgent)">
         <h2 style="font-family:var(--display);font-size:18px;margin:0 0 4px">Your WhatsApp connection has expired.</h2>
         <p class="hint" style="margin:0">
           Meta's permission for this connection ran out on ${escapeHtml(expiryDate)}, so missed-call
           messages are not being sent. Press Connect WhatsApp below to renew it. Your leads and settings are kept.
         </p>
       </div>`
    : "";

  const steps = onboarding
    ? `<ul class="steps">
         <li class="${onboarding.PROFILE_COMPLETE ? "done" : ""}">Business profile</li>
         <li class="${onboarding.AI_CONFIGURED ? "done" : ""}">Services and areas</li>
         <li class="${onboarding.WHATSAPP_CONNECTED ? "done" : ""}">WhatsApp connected</li>
       </ul>`
    : "";

  // ------------------------------------------------ advanced / manual
  //
  // Unchanged in every field name and in what it does. It moved behind a
  // disclosure and gained a warning; it did not lose a capability, and the
  // technical facts about the current connection live here too rather than
  // on a screen meant for someone who has never seen a Meta dashboard.

  const technical = integration
    ? `<dl class="facts" style="margin-bottom:16px">
         <dt>Status</dt><dd><span class="state ${escapeHtml(status)}">${escapeHtml(status)}</span></dd>
         <dt>Phone</dt><dd>${escapeHtml(integration.displayPhoneNumber || "—")}</dd>
         <dt>Number ID</dt><dd>${escapeHtml(integration.phoneNumberId)}</dd>
         <dt>WABA ID</dt><dd>${escapeHtml(integration.wabaId || "—")}</dd>
         <dt>Verified</dt><dd>${escapeHtml(integration.lastVerifiedAt || "never")}</dd>
         ${integration.lastError ? `<dt>Last error</dt><dd>${escapeHtml(integration.lastError)}</dd>` : ""}
       </dl>`
    : `<dl class="facts" style="margin-bottom:16px">
         <dt>Status</dt><dd><span class="state NOT_CONNECTED">NOT_CONNECTED</span></dd>
       </dl>`;

  const manualForm = canManage
    ? `<form method="POST" action="/settings/whatsapp">
         <label for="phoneNumberId">Phone number ID</label>
         <input id="phoneNumberId" name="phoneNumberId" required autocomplete="off">
         <label for="displayPhoneNumber">Display phone number</label>
         <input id="displayPhoneNumber" name="displayPhoneNumber" placeholder="+91…" autocomplete="off">
         <label for="wabaId">WhatsApp Business Account ID</label>
         <input id="wabaId" name="wabaId" required autocomplete="off">
         <label for="accessToken">Access token</label>
         <input type="password" id="accessToken" name="accessToken" required autocomplete="off">
         <label for="appSecret">App secret</label>
         <input type="password" id="appSecret" name="appSecret" autocomplete="off">
         <label for="verifyToken">Verify token</label>
         <input type="password" id="verifyToken" name="verifyToken" autocomplete="off">
         <button class="full" type="submit">Save and verify</button>
         <p class="hint">
           Saving stores the credentials, then asks Meta whether they actually work:
           that the token reaches this number, and that this number belongs to that
           WhatsApp Business Account. Only Meta's answer can make this CONNECTED —
           a saved form is not a working connection.
         </p>
       </form>`
    : "";

  // A healthy connection hides the connect card, and with it the error
  // block. A failed manual save would then report nothing, so the error
  // moves in here beside the form that produced it, opened.
  const advancedError = connected && !tokenIsExpired ? errorBlock(error) : "";

  const advanced = `
    <details class="card advanced" id="advanced"${failure || advancedError ? " open" : ""}>
      <summary>Need to connect manually? Advanced / Manual Setup</summary>
      <div class="advanced-body">
        <p class="warn">
          Manual setup is intended for technical administrators. Most businesses
          should use Connect WhatsApp.
        </p>
        ${technical}
        ${advancedError}
        ${manualForm}
      </div>
    </details>`;

  return page("WhatsApp settings", `
    <div class="masthead">
      <div>
        <h1>WhatsApp</h1>
        <div class="sub">${escapeHtml(business?.name ?? "")}</div>
      </div>
      <a class="backlink" href="/leads">Leads</a>
    </div>
    ${notice}
    ${templatesNotice}
    ${testMessageNotice}
    ${failureNotice}
    ${connected && !tokenIsExpired
      ? `${success}${steps}`
      : connected
      ? `${expiredCard}${connectCard}`
      : `${connectCard}${interim}<div class="notice">WhatsApp is not connected yet, so no leads can be captured.${steps}</div>`}
    ${advanced}
    ${settingsNav("/settings/whatsapp")}`,
    canManage && signup?.available && (!connected || tokenIsExpired) ? embeddedSignupScript(signup) : "",
    { active: "/settings/whatsapp", business: shellBusiness ?? business, actor });
}

/**
 * The Embedded Signup client.
 *
 * It does three things and deliberately nothing else: open Meta's flow,
 * catch the two pieces Meta hands back (the asset ids over postMessage,
 * the exchangeable code in the login callback), and POST both to our
 * server. It does not decide whether the connection worked — the server
 * asks Meta that and answers with a redirect.
 *
 * Rules this code exists to keep:
 *
 * 1. Nothing is persisted in the browser. No localStorage, no
 *    sessionStorage, no cookie of its own. The code lives in a closure
 *    variable for the few seconds between callback and POST, and Meta
 *    expires it in well under a minute anyway.
 * 2. Nothing sensitive goes in a URL. The code is a POST body.
 * 3. Messages are only trusted from Meta's own origins, and only in the
 *    shape Embedded Signup documents.
 * 4. Every failure path leaves the customer with a sentence and two ways
 *    forward, never a raw error.
 *
 * Plain DOM code, no build step, matching the checkout client above.
 */
function embeddedSignupScript(signup) {
  return `<script>
(function () {
  var btn = document.getElementById("connect-whatsapp");
  if (!btn) return;
  // Both connect buttons share one flow. "app" keeps the number on the
  // owner's WhatsApp Business app (Meta coexistence); "api" moves it.
  var buttons = [btn, document.getElementById("connect-whatsapp-app")].filter(Boolean);
  var mode = "api";
  var sawAppOnboarding = false;
  function setDisabled(v) { buttons.forEach(function (b) { b.disabled = v; }); }
  var out = document.getElementById("connect-status");
  var recover = document.getElementById("connect-recover");
  var CFG = ${jsonForScript({ appId: signup.appId, configId: signup.configId, version: signup.graphVersion })};
  var assets = null;
  var busy = false;

  function say(msg) { if (out) { out.textContent = msg; out.hidden = false; } }
  function fail(msg) {
    busy = false;
    setDisabled(false);
    say(msg);
    if (recover) recover.hidden = false;
  }

  // Meta posts the selected WABA and business phone number into the window
  // that opened the flow. Origin-checked, and only the documented shape is
  // read — any other message on the page is ignored entirely.
  // Any https://*.facebook.com origin: Embedded Signup is served from
  // business.facebook.com as well as www/web, and accepting only two hosts
  // silently threw away the one message that names the chosen number.
  var META_ORIGIN = /^https:\\/\\/([a-z0-9-]+\\.)*facebook\\.com$/;
  // What arrived from Meta, by shape only (no ids, no codes), so a flow that
  // returns a code without a number can be diagnosed from the server log.
  var seen = [];
  window.addEventListener("message", function (ev) {
    if (!META_ORIGIN.test(ev.origin)) return;
    var data;
    try { data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
    if (seen.length < 12) {
      seen.push({
        origin: ev.origin,
        type: (data && typeof data === "object" && String(data.type || "").slice(0, 40)) || typeof data,
        event: (data && typeof data === "object" && String(data.event || "").slice(0, 40)) || ""
      });
    }
    if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;

    if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA" || data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
      assets = {
        phoneNumberId: (data.data && data.data.phone_number_id) || "",
        wabaId: (data.data && data.data.waba_id) || ""
      };
      if (data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") sawAppOnboarding = true;
    } else if (data.event === "CANCEL") {
      fail("WhatsApp connection wasn't completed. You can try again or use Advanced setup.");
    }
  });

  // Meta binds the code to the redirect_uri of the dialog the SDK opened,
  // and for a popup that is one of Meta's own relay addresses with values
  // minted per login. It cannot be guessed, but it can be read: the SDK
  // opens the dialog with window.open, and the address is right there in
  // its redirect_uri parameter. The server needs it to exchange the code.
  var dialogRedirectUri = "";
  var nativeOpen = window.open;
  window.open = function (url) {
    try {
      var u = new URL(String(url), location.href);
      if (/(^|\\.)facebook\\.com$/.test(u.hostname) && u.pathname.indexOf("/dialog/oauth") !== -1) {
        dialogRedirectUri = u.searchParams.get("redirect_uri") || "";
      }
    } catch (e) { /* not a URL we care about */ }
    return nativeOpen.apply(window, arguments);
  };

  function send(code) {
    say("Finishing your connection\\u2026");
    fetch("/settings/whatsapp/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        code: code || "",
        phoneNumberId: (assets && assets.phoneNumberId) || "",
        wabaId: (assets && assets.wabaId) || "",
        seen: seen,
        pageUrl: location.href.split("#")[0],
        dialogRedirectUri: dialogRedirectUri,
        coexistence: mode === "app" || sawAppOnboarding
      })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        var body = res.body || {};
        if (res.ok && body.redirect) { location.assign(body.redirect); return; }
        if (body.redirect) { location.assign(body.redirect); return; }
        fail(body.error || "WhatsApp connection wasn't completed. You can try again or use Advanced setup.");
      })
      .catch(function () {
        fail("We couldn't reach the server to finish connecting. Try again in a moment.");
      });
  }

  // Meta does not promise an order: the login callback can land before the
  // message carrying the chosen number, especially on phones where the flow
  // runs in a separate tab. Wait briefly for the number instead of giving
  // up the moment the callback fires.
  //
  // Every outcome — including "no code" and "no number" — is POSTed, so the
  // server logs WHY a connection did not complete and answers with the
  // sentence to show. A failure that only exists in the browser cannot be
  // diagnosed from anywhere else.
  function onLogin(response) {
    var code = response && response.authResponse && response.authResponse.code;
    if (!code) { send(""); return; }
    var waited = 0;
    (function waitForAssets() {
      if ((assets && assets.phoneNumberId && assets.wabaId) || waited >= 8000) { send(code); return; }
      waited += 250;
      setTimeout(waitForAssets, 250);
    })();
  }

  function start(which) {
    if (busy) return;
    if (!window.FB) {
      fail("The Meta connection window couldn't load. Check your connection, then try again.");
      return;
    }
    busy = true;
    setDisabled(true);
    assets = null;
    mode = which === "app" ? "app" : "api";
    sawAppOnboarding = false;
    // On a phone the Meta flow opens as a separate tab and ends on a page
    // that says "Please close this tab". Say so up front, or the owner is
    // left on that page wondering whether anything happened.
    say("Opening Meta\\u2026 On a phone, Facebook opens in a new tab: finish there, close it when it says so, and come back to this tab.");
    window.FB.login(onLogin, {
      config_id: CFG.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, featureType: mode === "app" ? "whatsapp_business_app_onboarding" : "", sessionInfoVersion: "3" }
    });
  }
  buttons.forEach(function (b) {
    b.addEventListener("click", function () { start(b.getAttribute("data-mode")); });
  });

  window.fbAsyncInit = function () {
    window.FB.init({ appId: CFG.appId, autoLogAppEvents: true, xfbml: true, version: CFG.version });
  };
}());
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>`;
}

export function teamSettingsPage({ members = [], canManage = false, role = "", error, business = null, actor = null } = {}) {
  const rows = members.length
    ? members.map((m) => `
        <tr>
          <td>${escapeHtml(m.email)}</td>
          <td>${escapeHtml(m.role)}</td>
          <td style="text-align:right">
            ${canManage && m.role !== "OWNER"
              ? `<form method="POST" action="/settings/team" style="display:inline">
                   <input type="hidden" name="action" value="remove">
                   <input type="hidden" name="membershipId" value="${escapeHtml(m.id)}">
                   <button class="ghost" type="submit">Remove</button>
                 </form>`
              : ""}
          </td>
        </tr>`).join("")
    : `<tr><td colspan="3" class="hint">No members yet.</td></tr>`;

  const addForm = canManage
    ? `<form class="card" method="POST" action="/settings/team">
         <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Add a member</h2>
         <p class="hint" style="margin:0 0 4px">
           They must already have an account — email invitations aren't available yet.
         </p>
         <label for="email">Email</label>
         <input type="email" id="email" name="email" required>
         <label for="role">Role</label>
         <select id="role" name="role">
           <option value="ADMIN">ADMIN — manage settings</option>
           <option value="STAFF">STAFF — leads only</option>
         </select>
         <button class="full" type="submit">Add member</button>
         ${errorBlock(error)}
       </form>`
    : `<div class="card"><p class="hint" style="margin:0">
         Your role (${escapeHtml(role || "STAFF")}) cannot manage team members.
       </p>${errorBlock(error)}</div>`;

  return page("Team", `
    <div class="masthead">
      <div><h1>Team</h1></div>
      <a class="backlink" href="/settings/whatsapp">WhatsApp</a>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${addForm}
    ${settingsNav("/settings/team")}`, "",
    { active: "/settings/team", business, actor });
}

/**
 * Plan, usage and limits.
 *
 * Every number here comes from a stored counter or the entitlement
 * table — there are no placeholder figures, and no plan is shown as
 * active unless the subscription record says so. When nobody has chosen
 * a plan the page says exactly that rather than implying FREE was picked.
 */
export function billingPage({
  business, subscription, entitlements, usage, plans = {}, role = "",
  checkout = null, pricing = {}, prefill = {}, actor = null,
} = {}) {
  const plan = entitlements?.plan ?? "FREE";
  const limits = entitlements?.limits ?? {};

  const meter = (metric, limitKey, label) => {
    const used = usage?.counts?.[metric] ?? 0;
    const limit = limits[limitKey];
    const unlimited = limit === null || limit === undefined;
    const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
    return `
      <dt>${escapeHtml(label)}</dt>
      <dd>
        ${used} ${unlimited ? "used (no limit on this plan)" : `of ${limit} this month`}
        ${unlimited ? "" : `<div class="bar"><span style="width:${pct}%"></span></div>`}
      </dd>`;
  };

  // Checkout started but not yet confirmed by a webhook. The plan shown
  // above is still the OLD one, because that is still what is true: a
  // browser returning from Razorpay's widget proves nothing about whether
  // money moved. Only the signed webhook changes the plan.
  const pending = subscription?.pendingPlan && subscription.pendingPlan !== subscription.plan
    ? `<div class="notice">
         Payment for ${escapeHtml(subscription.pendingPlan)} is being confirmed.
         Your plan stays ${escapeHtml(subscription.plan)} until the payment provider confirms it —
         this page will show the new plan once that happens.
       </div>`
    : "";

  // A subscription nobody has chosen is described as exactly that.
  const planNote = subscription?.implicit
    ? `<p class="hint" style="margin:8px 0 0">No plan has been selected for this business, so it runs on the default FREE entitlements.</p>`
    : "";

  const degraded = subscription && subscription.plan !== subscription.effectivePlan
    ? `<p class="hint" style="margin:8px 0 0">This business is on ${escapeHtml(subscription.plan)} but its subscription is ${escapeHtml(subscription.status)}, so ${escapeHtml(subscription.effectivePlan)} limits apply.</p>`
    : "";

  // Whether this page should ship the payment script at all. Same
  // conditions the upgrade button uses, so a page with no button never
  // carries checkout code.
  const canBuy = plan === "FREE"
    && (role === "OWNER" || role === "ADMIN")
    && Boolean(checkout?.available)
    && (checkout?.purchasable ?? []).some((name) => pricing?.[name]?.display);

  // Prices come from the server's pricing table via `pricing`; the view
  // never computes or restates one.
  const comparison = Object.entries(plans).map(([name, p]) => `
    <tr${name === plan ? ' style="font-weight:600"' : ""}>
      <td>${escapeHtml(name)}${name === plan ? " (current)" : ""}</td>
      <td>${escapeHtml(pricing?.[name]?.display ?? "")}</td>
      <td>${p.leadsPerMonth ?? "No limit"}</td>
      <td>${p.messagesPerMonth ?? "No limit"}</td>
      <td>${p.teamMembers ?? "No limit"}</td>
    </tr>`).join("");

  return page("Billing", `
    <div class="masthead">
      <div>
        <h1>Billing</h1>
        <div class="sub">${escapeHtml(business?.name ?? "")}</div>
      </div>
      <a class="backlink" href="/leads">Leads</a>
    </div>

    <div class="card">
      <dl class="facts">
        <dt>Current plan</dt><dd><span class="state CONFIGURED">${escapeHtml(plan)}</span></dd>
        <dt>Subscription status</dt><dd>${escapeHtml(subscription?.status ?? "ACTIVE")}</dd>
        <dt>Billing period</dt>
        <dd>${escapeHtml((usage?.periodStart ?? "").slice(0, 10))} to ${escapeHtml((usage?.periodEnd ?? "").slice(0, 10))}</dd>
      </dl>
      ${planNote}
      ${degraded}
    </div>

    <div class="card">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 8px">Usage this month</h2>
      <dl class="facts">
        ${meter("leads", "leadsPerMonth", "Leads")}
        ${meter("messages", "messagesPerMonth", "WhatsApp messages")}
      </dl>
    </div>

    <div class="card">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 8px">Plans</h2>
      <table class="rows">
        <thead><tr><th>Plan</th><th>Price</th><th>Leads/mo</th><th>Messages/mo</th><th>Team</th></tr></thead>
        <tbody>${comparison}</tbody>
      </table>
      <p class="hint" style="margin:12px 0 0">
        Usage limits are provisional. Plans without a price are not available for purchase.
      </p>
    </div>

    <div class="card">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 8px">Upgrade</h2>
      ${upgradeBlock({ checkout, plan, role, pricing })}
    </div>

    ${settingsNav("/settings/billing")}`,
    // Only wired up when there is genuinely something to buy; otherwise
    // the page ships no payment script at all.
    canBuy ? checkoutScript({ businessName: business?.name ?? "", prefill }) : "",
    { active: "/settings/billing", business, actor });
}

/**
 * The upgrade call to action.
 *
 * Shows a real action ONLY when the server can actually sell the plan —
 * that is, a payment provider and a configured price both exist. When
 * they do not, it says so plainly instead of rendering a button that
 * would fail, and it never quotes a price this codebase does not hold.
 */
function upgradeBlock({ checkout, plan, role, pricing = {} }) {
  if (plan !== "FREE") {
    return `<p class="hint" style="margin:0">This business is on ${escapeHtml(plan)}.</p>`;
  }
  if (role !== "OWNER" && role !== "ADMIN") {
    return `<p class="hint" style="margin:0">Only an owner or admin can change the plan.</p>`;
  }
  if (!checkout?.available) {
    return `<p class="hint" style="margin:0">
      Paid plans are not available online yet — the payment provider is not connected,
      so nothing here can charge you.
    </p>`;
  }
  // Only plans the server marks purchasable get a button. A plan with no
  // decided price has nothing to put on one.
  const buyable = (checkout.purchasable ?? []).filter((name) => pricing?.[name]?.display);
  if (!buyable.length) {
    return `<p class="hint" style="margin:0">No plan is currently available for purchase.</p>`;
  }
  // A button, not a form post: the endpoint answers JSON and the payment
  // widget has to be opened from script. Without JavaScript there is no
  // way to take a card payment at all, so `noscript` says so plainly
  // rather than offering a control that cannot work.
  return buyable.map((name) => `<div>
      <button class="full" type="button" id="upgrade-${escapeHtml(name)}" data-plan="${escapeHtml(name)}">
        Upgrade to ${escapeHtml(name)} — ${escapeHtml(pricing[name].display)}
      </button>
      <p class="hint" id="checkout-status" role="status" aria-live="polite" hidden></p>
      <p class="hint">You'll be taken to our payment provider. Your plan changes only after payment is confirmed.</p>
      <noscript><p class="hint">Upgrading needs JavaScript enabled, because the payment form runs in your browser.</p></noscript>
    </div>`).join("");
}

/**
 * The checkout client.
 *
 * Three rules it exists to obey:
 *
 * 1. It never decides the plan. The widget's success callback means the
 *    customer finished a form, not that money moved — so on success it
 *    asks the SERVER what the plan is, and keeps asking until the answer
 *    changes, which only the verified webhook can cause.
 * 2. It never sends a price, a currency, a Razorpay plan id or a
 *    business id. It sends a plan NAME; the server decides the rest.
 * 3. Every failure — dismissed widget, declined payment, blocked script,
 *    network error — leaves the plan exactly as it was, and says so.
 *
 * Plain DOM code with no build step, matching the rest of this codebase.
 */
function checkoutScript({ businessName = "", prefill = {} } = {}) {
  return `<script>
(function () {
  var btn = document.querySelector("[id^='upgrade-']");
  if (!btn) return;
  var out = document.getElementById("checkout-status");
  var BUSINESS = ${jsonForScript(businessName)};
  var PREFILL = ${jsonForScript(prefill)};
  var busy = false;

  function say(msg) { if (out) { out.textContent = msg; out.hidden = false; } }
  function release(msg) { busy = false; btn.disabled = false; say(msg); }

  function loadWidget(cb) {
    if (window.Razorpay) return cb(null);
    var s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = function () { cb(window.Razorpay ? null : new Error("Payment form unavailable.")); };
    s.onerror = function () { cb(new Error("Payment form could not be loaded.")); };
    document.head.appendChild(s);
  }

  var tries = 0;
  function confirmWithServer() {
    tries++;
    fetch("/billing/status", { headers: { "Accept": "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.plan === "PRO") {
          say("Subscription active. Refreshing\\u2026");
          setTimeout(function () { location.reload(); }, 800);
          return;
        }
        if (tries < 10) {
          say("Payment confirmation is pending\\u2026");
          setTimeout(confirmWithServer, 3000);
        } else {
          say("Payment confirmation is still pending. This page will show PRO as soon as your payment is confirmed \\u2014 you do not need to pay again.");
        }
      })
      .catch(function () {
        if (tries < 10) setTimeout(confirmWithServer, 3000);
        else say("Could not reach the server to confirm. Reload this page shortly.");
      });
  }

  btn.addEventListener("click", function () {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    say("Starting checkout\\u2026");

    fetch("/billing/create-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ plan: btn.getAttribute("data-plan") })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.subscriptionId) {
          throw new Error((res.body && res.body.error) || "Could not start checkout.");
        }
        loadWidget(function (err) {
          if (err) {
            release(err.message + " Nothing has been charged and your plan is unchanged.");
            return;
          }
          var rzp = new window.Razorpay({
            key: res.body.keyId,
            subscription_id: res.body.subscriptionId,
            name: BUSINESS || "MissedCall",
            description: res.body.plan + " \\u2014 " + res.body.displayPrice,
            prefill: PREFILL,
            handler: function () {
              say("Payment submitted. We're confirming your subscription\\u2026");
              confirmWithServer();
            },
            modal: {
              ondismiss: function () {
                release("Checkout closed. Nothing has been charged and your plan is unchanged.");
              }
            }
          });
          if (rzp.on) {
            rzp.on("payment.failed", function () {
              release("Payment failed. Your plan has not changed.");
            });
          }
          rzp.open();
        });
      })
      .catch(function (e) {
        release(e && e.message ? e.message : "Could not start checkout.");
      });
  });
})();
</script>`;
}

/**
 * The business profile form.
 *
 * Fields are grouped by whether the runtime actually uses them, and the
 * page says so. "Services" and "Service areas" are stored and drive the
 * onboarding checklist, but nothing in the conversation engine reads them
 * yet — labelling them as live configuration would be a promise the code
 * does not keep.
 */
export function businessSettingsPage({
  business = {}, canManage = false, role = "", errors = {}, error = "", saved = false, actor = null,
} = {}) {
  const v = (k) => escapeHtml(business?.[k] ?? "");
  const csv = (k) => escapeHtml((business?.[k] ?? []).join(", "));
  const err = (k) => (errors?.[k] ? `<p class="error">${escapeHtml(errors[k])}</p>` : "");
  const ro = canManage ? "" : " disabled";

  const form = `<form class="card" method="POST" action="/settings/business">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Profile</h2>
      <p class="hint" style="margin:0 0 4px">What customers are told, and where your leads go.</p>

      <label for="name">Business name</label>
      <input id="name" name="name" value="${v("name")}" required${ro}>
      ${err("name")}

      <label for="industry">Industry</label>
      <input id="industry" name="industry" value="${v("industry")}"${ro}>

      <label for="businessPhone">Business phone</label>
      <input id="businessPhone" name="businessPhone" value="${v("businessPhone")}" placeholder="+91…"${ro}>

      <label for="ownerName">Owner name</label>
      <input id="ownerName" name="ownerName" value="${v("ownerName")}"${ro}>

      <h2 style="font-family:var(--display);font-size:19px;margin:22px 0 4px">Lead notifications</h2>
      <label for="ownerWhatsApp">Send new leads to this WhatsApp number</label>
      <input id="ownerWhatsApp" name="ownerWhatsApp" value="${v("ownerWhatsApp")}" placeholder="+919876543210" required${ro}>
      <p class="hint">International format. Every new lead is sent here — if this is wrong, you will not hear about your leads. Saving does not send a test message.</p>
      ${err("ownerWhatsApp")}

      <label for="timezone">Timezone</label>
      <input id="timezone" name="timezone" value="${v("timezone")}"${ro}>
      ${err("timezone")}

      <h2 style="font-family:var(--display);font-size:19px;margin:22px 0 4px">Services and areas</h2>
      <p class="hint" style="margin:0 0 4px">
        Stored on your business and used for your setup checklist. The automated replies
        do not read these yet, so changing them will not change what customers are sent.
      </p>

      <label for="services">Services</label>
      <input id="services" name="services" value="${csv("services")}" placeholder="AC repair, Wiring"${ro}>
      <p class="hint">Comma separated.</p>

      <label for="areas">Service areas</label>
      <input id="areas" name="areas" value="${csv("areas")}" placeholder="Kukatpally, Madhapur"${ro}>

      <label for="greeting">Greeting</label>
      <input id="greeting" name="greeting" value="${v("greeting")}"${ro}>
      ${err("greeting")}

      ${canManage ? `<button class="full" type="submit">Save changes</button>` : ""}
      ${errorBlock(error)}
    </form>`;

  const roleNote = canManage
    ? ""
    : `<div class="card"><p class="hint" style="margin:0">Your role (${escapeHtml(role || "STAFF")}) can view these settings but not change them.</p></div>`;

  return page("Business settings", `
    <div class="masthead">
      <div>
        <h1>Business</h1>
        <div class="sub">${escapeHtml(business?.name ?? "")}</div>
      </div>
      <a class="backlink" href="/leads">Leads</a>
    </div>
    ${saved ? `<div class="notice">Settings saved.</div>` : ""}
    ${roleNote}
    ${form}
    ${settingsNav("/settings/business")}`, "",
    { active: "/settings/business", business, actor });
}

/** One navigation strip, so every settings page links to the others. */
export function settingsNav(current = "") {
  const links = [
    ["/settings/business", "Business"],
    ["/settings/whatsapp", "WhatsApp"],
    ["/settings/phone", "Phone setup"],
    ["/settings/team", "Team"],
    ["/settings/billing", "Billing"],
  ];
  return `<p class="sub">${links
    .filter(([href]) => href !== current)
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join(" · ")}</p>`;
}

/**
 * /settings/phone — the key a business's phone uses to report missed calls,
 * and how to set the phone up.
 *
 * The key is shown exactly once, on the response to the request that
 * created it. It is never rendered again: a page anyone on the team can
 * open must not be a place the key can be read back from. Losing it costs
 * a regenerate, which is the right trade.
 */
export function phoneSetupPage({
  business = {}, hasKey = false, keyCreatedAt = null, newKey = "", envManaged = false,
  canManage = false, role = "", baseUrl = "", error = "", actor = null,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/missed-call`;

  const justCreated = newKey
    ? `<div class="card" style="border-color:var(--brand, #12805c)">
         <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Your new key</h2>
         <p class="hint" style="margin:0 0 10px">Copy it now. It is shown only this once. If you lose it, create a new one and update the phone.</p>
         <input id="new-key" readonly value="${escapeHtml(newKey)}" onclick="this.select()" style="font-family:monospace">
       </div>`
    : "";

  const state = envManaged
    ? `<p class="hint" style="margin:0">This business's key is managed by the MissedCall team. Contact support to change it.</p>`
    : hasKey
      ? `<p class="hint" style="margin:0 0 12px">A key is active${keyCreatedAt ? `, created ${escapeHtml(String(keyCreatedAt).slice(0, 10))}` : ""}. Creating a new one stops the old one working immediately, so the phone must be updated straight after.</p>`
      : `<p class="hint" style="margin:0 0 12px">No key yet. Until one is created and entered on the phone, missed calls cannot be reported.</p>`;

  const action = envManaged
    ? ""
    : canManage
      ? `<form method="POST" action="/settings/phone/key">
           <button type="submit">${hasKey ? "Create a new key" : "Create key"}</button>
         </form>`
      : `<p class="hint" style="margin:0">Your role (${escapeHtml(role || "STAFF")}) can view this but not create a key.</p>`;

  const keyCard = `<div class="card">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Missed-call key</h2>
      <p class="hint" style="margin:0 0 12px">Your phone uses this key to tell MissedCall that a call was missed. It identifies your business, so keep it private.</p>
      ${state}
      ${action}
      ${errorBlock(error)}
    </div>`;

  const guide = `<div class="card">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Set up your Android phone</h2>
      <p class="hint" style="margin:0 0 12px">Do this once on the phone that receives your business calls. It takes about 10 minutes. iPhones cannot do this.</p>
      <ol class="hint" style="margin:0;padding-left:20px;line-height:1.7">
        <li>Install <strong>MacroDroid</strong> from the Play Store and open it.</li>
        <li>Tap <strong>Add Macro</strong>.</li>
        <li><strong>Trigger:</strong> Call/SMS → <strong>Call Missed</strong> → Any Number.</li>
        <li><strong>Action:</strong> Web Interactions → <strong>HTTP Request</strong>, then set:
          <ul style="margin:6px 0 6px;padding-left:18px">
            <li>Method: <strong>POST</strong></li>
            <li>URL: <code>${escapeHtml(endpoint)}</code></li>
            <li>Header <code>Authorization</code>: <code>Bearer YOUR-KEY</code> (the word Bearer, a space, then your key)</li>
            <li>Content type: <code>application/json</code></li>
            <li>Body: <code>{"callerNumber":"[call_number]"}</code></li>
          </ul>
        </li>
        <li>Name the macro "MissedCall" and save it.</li>
        <li>When Android asks, allow MacroDroid to read call logs and phone state, and turn off battery optimisation for MacroDroid so it keeps running.</li>
        <li><strong>Test it:</strong> call this phone from another phone and let it ring out. The caller should get your WhatsApp message within a few seconds.</li>
      </ol>
      <p class="hint" style="margin:12px 0 0">The caller's number must reach MissedCall with its country code, like +919876543210. If your phone shows numbers without +91, add it in MacroDroid before <code>[call_number]</code>. Calls from the owner's own number are ignored, and the same caller is not messaged twice within 10 minutes.</p>
    </div>`;

  const ivrEndpoint = `${String(baseUrl).replace(/\/$/, "")}/ivr/missed-call`;
  const ivrGuide = `<div class="card">
      <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Using an IVR or cloud number instead?</h2>
      <p class="hint" style="margin:0 0 12px">If your calls come in through an IVR or cloud telephony provider (Exotel, Knowlarity, MyOperator, Twilio and others), they never ring an Android phone, so skip MacroDroid. Ask your provider to call this URL whenever a call is missed or not answered:</p>
      <input readonly value="${escapeHtml(ivrEndpoint)}?key=YOUR-KEY" onclick="this.select()" style="font-family:monospace">
      <ul class="hint" style="margin:12px 0 0;padding-left:18px;line-height:1.7">
        <li>GET or POST both work, and the body can be a form or JSON.</li>
        <li>The caller's number is read from the provider's own field (<code>CallFrom</code>, <code>From</code>, <code>caller_id</code>, <code>caller_number</code> and similar). Numbers without +91 are treated as Indian.</li>
        <li>If your provider sends every call, MissedCall skips the ones a person answered (<code>DialCallStatus</code> or <code>call_status</code> set to completed/answered).</li>
        <li>If your provider can set a header, send <code>Authorization: Bearer YOUR-KEY</code> instead of putting the key in the URL.</li>
      </ul>
    </div>`;

  return page("Phone setup", `
    <div class="masthead">
      <div>
        <h1>Phone setup</h1>
        <div class="sub">${escapeHtml(business?.name ?? "")}</div>
      </div>
      <a class="backlink" href="/leads">Leads</a>
    </div>
    ${justCreated}
    ${keyCard}
    ${guide}
    ${ivrGuide}
    ${settingsNav("/settings/phone")}`, "",
    { active: "/settings/phone", business, actor });
}
