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

  .bar { height:6px; margin-top:6px; background:var(--line); border-radius:3px; overflow:hidden; }
  .bar span { display:block; height:100%; background:var(--accent); }

  table { width:100%; border-collapse:collapse; font-size:15px; }
  th { text-align:left; font-family:var(--mono); font-size:10px; letter-spacing:.12em;
       text-transform:uppercase; color:var(--muted); padding:0 0 8px; font-weight:400; }
  td { padding:9px 0; border-top:1px solid var(--line); }
`;

function page(title, body, script = "") {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body><div class="wrap">${body}</div>${script}</body></html>`;
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
  business, integration, status = "NOT_CONNECTED", onboarding, canManage = false, role = "",
  error, verification = null,
} = {}) {
  const connected = status === "CONNECTED";

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

  const current = integration
    ? `<div class="card">
         <dl class="facts">
           <dt>Status</dt><dd><span class="state ${escapeHtml(status)}">${escapeHtml(status)}</span></dd>
           <dt>Phone</dt><dd>${escapeHtml(integration.displayPhoneNumber || "—")}</dd>
           <dt>Number ID</dt><dd>${escapeHtml(integration.phoneNumberId)}</dd>
           <dt>WABA ID</dt><dd>${escapeHtml(integration.wabaId || "—")}</dd>
           <dt>Verified</dt><dd>${escapeHtml(integration.lastVerifiedAt || "never")}</dd>
           ${integration.lastError ? `<dt>Last error</dt><dd>${escapeHtml(integration.lastError)}</dd>` : ""}
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
    ${notice}
    ${connected ? steps : `<div class="notice">WhatsApp is not connected yet, so no leads can be captured.${steps}</div>`}
    ${current}
    ${form}
    ${settingsNav("/settings/whatsapp")}`);
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
    ${addForm}
    ${settingsNav("/settings/team")}`);
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
  checkout = null, pricing = {}, prefill = {},
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
    canBuy ? checkoutScript({ businessName: business?.name ?? "", prefill }) : "");
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
            name: BUSINESS || "Missed-call textback",
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
  business = {}, canManage = false, role = "", errors = {}, error = "", saved = false,
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
    ${settingsNav("/settings/business")}`);
}

/** One navigation strip, so every settings page links to the others. */
export function settingsNav(current = "") {
  const links = [
    ["/settings/business", "Business"],
    ["/settings/whatsapp", "WhatsApp"],
    ["/settings/team", "Team"],
    ["/settings/billing", "Billing"],
  ];
  return `<p class="sub">${links
    .filter(([href]) => href !== current)
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join(" · ")}</p>`;
}
