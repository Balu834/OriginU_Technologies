/**
 * Signup, onboarding and settings pages.
 *
 * Shares the dashboard's tokens so the whole product reads as one thing.
 * No page here ever receives a credential to render — the settings view
 * is handed `publicView(integration)`, which cannot contain one.
 */
import { TOKENS, escapeHtml } from "./views.mjs";

const STYLES = `
  ${TOKENS}
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

  table { width:100%; border-collapse:collapse; font-size:15px; }
  th { text-align:left; font-family:var(--mono); font-size:10px; letter-spacing:.12em;
       text-transform:uppercase; color:var(--muted); padding:0 0 8px; font-weight:400; }
  td { padding:9px 0; border-top:1px solid var(--line); }
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

const errorBlock = (error) => (error ? `<p class="error">${escapeHtml(error)}</p>` : "");

export function signupPage({ error, email = "" } = {}) {
  return page("Create account", `
    <div class="plate">Missed-call textback</div>
    <h1>Create your account</h1>
    <p class="sub">One account, then you'll set up your business.</p>
    <form class="card" method="POST" action="/signup" style="margin-top:22px">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" value="${escapeHtml(email)}" autocomplete="email" required>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="new-password" required minlength="10">
      <p class="hint">At least 10 characters.</p>
      <button class="full" type="submit">Create account</button>
      ${errorBlock(error)}
    </form>
    <p class="sub">Already have one? <a href="/login">Sign in</a>.</p>`);
}

export function onboardingPage({ error } = {}) {
  return page("Set up your business", `
    <div class="plate">Step 1 of 2</div>
    <h1>Your business</h1>
    <p class="sub">This is what customers see and how leads reach you.</p>
    <form class="card" method="POST" action="/onboarding" style="margin-top:22px">
      <label for="name">Business name</label>
      <input id="name" name="name" required placeholder="Planet Electrical">

      <label for="industry">Industry</label>
      <input id="industry" name="industry" placeholder="Electrical">

      <label for="businessPhone">Business phone</label>
      <input id="businessPhone" name="businessPhone" placeholder="+91…">

      <label for="ownerName">Owner name</label>
      <input id="ownerName" name="ownerName" placeholder="Mohamed">

      <label for="ownerWhatsApp">Where should leads be sent?</label>
      <input id="ownerWhatsApp" name="ownerWhatsApp" placeholder="+91… (WhatsApp)">
      <p class="hint">New leads arrive here as a WhatsApp message.</p>

      <label for="areas">Areas served</label>
      <input id="areas" name="areas" placeholder="Kukatpally, Madhapur">
      <p class="hint">Comma separated.</p>

      <label for="services">Services</label>
      <input id="services" name="services" placeholder="AC repair, Wiring">

      <label for="timezone">Timezone</label>
      <input id="timezone" name="timezone" value="Asia/Kolkata">

      <button class="full" type="submit">Create business</button>
      ${errorBlock(error)}
    </form>`);
}

export function whatsappSettingsPage({
  business, integration, status = "NOT_CONNECTED", onboarding, canManage = false, role = "", error,
} = {}) {
  const connected = status === "CONNECTED";

  const current = integration
    ? `<div class="card">
         <dl class="facts">
           <dt>Status</dt><dd><span class="state ${escapeHtml(status)}">${escapeHtml(status)}</span></dd>
           <dt>Phone</dt><dd>${escapeHtml(integration.displayPhoneNumber || "—")}</dd>
           <dt>Number ID</dt><dd>${escapeHtml(integration.phoneNumberId)}</dd>
           <dt>WABA ID</dt><dd>${escapeHtml(integration.wabaId || "—")}</dd>
           <dt>Verified</dt><dd>${escapeHtml(integration.lastVerifiedAt || "never")}</dd>
         </dl>
       </div>`
    : `<div class="card">
         <dl class="facts">
           <dt>Status</dt><dd><span class="state NOT_CONNECTED">NOT_CONNECTED</span></dd>
         </dl>
         <p class="hint" style="margin-top:12px">
           WhatsApp automation is unavailable until an integration is connected.
           Leads can't be captured yet.
         </p>
       </div>`;

  const steps = onboarding
    ? `<ul class="steps">
         <li class="${onboarding.PROFILE_COMPLETE ? "done" : ""}">Business profile</li>
         <li class="${onboarding.AI_CONFIGURED ? "done" : ""}">Services and areas</li>
         <li class="${onboarding.WHATSAPP_CONNECTED ? "done" : ""}">WhatsApp connected</li>
       </ul>`
    : "";

  const form = canManage
    ? `<form class="card" method="POST" action="/settings/whatsapp">
         <h2 style="font-family:var(--display);font-size:19px;margin:0 0 4px">Connect WhatsApp</h2>
         <p class="hint" style="margin:0 0 4px">
           From your Meta app: WhatsApp → API Setup. These are sent straight to the server,
           stored encrypted, and never shown again.
         </p>
         <label for="phoneNumberId">Phone number ID</label>
         <input id="phoneNumberId" name="phoneNumberId" required autocomplete="off">
         <label for="displayPhoneNumber">Display phone number</label>
         <input id="displayPhoneNumber" name="displayPhoneNumber" placeholder="+91…" autocomplete="off">
         <label for="wabaId">WhatsApp Business Account ID</label>
         <input id="wabaId" name="wabaId" autocomplete="off">
         <label for="accessToken">Access token</label>
         <input type="password" id="accessToken" name="accessToken" required autocomplete="off">
         <label for="appSecret">App secret</label>
         <input type="password" id="appSecret" name="appSecret" autocomplete="off">
         <label for="verifyToken">Verify token</label>
         <input type="password" id="verifyToken" name="verifyToken" autocomplete="off">
         <button class="full" type="submit">Save integration</button>
         <p class="hint">
           Saving stores the credentials as CONFIGURED. It stays CONFIGURED until a real
           message is sent successfully — a saved form is not a working connection.
         </p>
         ${errorBlock(error)}
       </form>`
    : `<div class="card">
         <p class="hint" style="margin:0">
           Your role (${escapeHtml(role || "STAFF")}) can view this but not change integration settings.
         </p>
         ${errorBlock(error)}
       </div>`;

  return page("WhatsApp settings", `
    <div class="masthead">
      <div>
        <h1>WhatsApp</h1>
        <div class="sub">${escapeHtml(business?.name ?? "")}</div>
      </div>
      <a class="backlink" href="/leads">Leads</a>
    </div>
    ${connected ? "" : `<div class="notice">WhatsApp is not connected yet, so no leads can be captured.${steps}</div>`}
    ${current}
    ${form}
    <p class="sub"><a href="/settings/team">Team settings</a></p>`);
}

export function teamSettingsPage({ members = [], canManage = false, role = "", error } = {}) {
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
    ${addForm}`);
}
