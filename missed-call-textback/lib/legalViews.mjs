/**
 * Privacy policy, terms and data-deletion instructions.
 *
 * Public, static, and the same for every visitor — nothing here reads a
 * tenant, a session or the store. Meta will not publish an app without a
 * reachable privacy policy and data-deletion URL, and a business handing
 * over its customers' phone numbers is owed a plain account of what
 * happens to them.
 *
 * Every statement describes what this codebase actually does. If the
 * product starts storing something new or using another processor, this
 * file changes in the same commit.
 */
import { escapeHtml } from "./views.mjs";

export const LEGAL_OPERATOR = {
  name: "Lavudiya Balu (trading as OriginU Technologies)",
  place: "Hyderabad, Telangana, India",
  email: "support@originutech.in",
};

export const LEGAL_UPDATED = "10 October 2026";

function legalPage(title, intro, sections) {
  const body = sections
    .map(
      ([heading, paragraphs]) => `
      <section>
        <h2>${escapeHtml(heading)}</h2>
        ${paragraphs.map((p) => (Array.isArray(p)
          ? `<ul>${p.map((li) => `<li>${li}</li>`).join("")}</ul>`
          : `<p>${p}</p>`)).join("")}
      </section>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · MissedCall</title>
<meta name="description" content="${escapeHtml(intro)}">
<style>
  :root { --ink:#16211c; --muted:#4f5d56; --line:#dfe6e1; --brand:#12805c; --bg:#fbfcfb; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:0 20px; }
  header { border-bottom:1px solid var(--line); background:#fff; }
  header .wrap { display:flex; justify-content:space-between; align-items:center; padding-top:16px; padding-bottom:16px; }
  a { color:var(--brand); }
  .brand { font-weight:700; color:var(--ink); text-decoration:none; font-size:18px; }
  main { padding:40px 0 56px; }
  h1 { font-size:32px; line-height:1.2; margin:0 0 8px; }
  h2 { font-size:19px; margin:32px 0 8px; }
  p, li { color:var(--muted); }
  .meta { font-size:14px; color:var(--muted); margin:0 0 20px; }
  ul { padding-left:20px; }
  footer { border-top:1px solid var(--line); padding:20px 0 40px; font-size:14px; color:var(--muted); }
  footer a { margin-right:14px; }
</style>
</head><body>
<header><div class="wrap">
  <a class="brand" href="/">MissedCall</a>
  <a href="/login">Login</a>
</div></header>
<main><div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Last updated ${escapeHtml(LEGAL_UPDATED)}</p>
  <p>${escapeHtml(intro)}</p>
  ${body}
</div></main>
<footer><div class="wrap">
  <a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/data-deletion">Data deletion</a>
  <p>${escapeHtml(LEGAL_OPERATOR.name)}, ${escapeHtml(LEGAL_OPERATOR.place)}. WhatsApp is a trademark of Meta Platforms, Inc.</p>
</div></footer>
</body></html>`;
}

const mail = `<a href="mailto:${LEGAL_OPERATOR.email}">${LEGAL_OPERATOR.email}</a>`;

export function privacyPage() {
  return legalPage(
    "Privacy Policy",
    "MissedCall sends a WhatsApp message to people who called a business and were not answered, and turns their replies into leads for that business. This page explains what information that involves and what is done with it.",
    [
      ["Who runs MissedCall", [
        `MissedCall is operated by ${escapeHtml(LEGAL_OPERATOR.name)}, ${escapeHtml(LEGAL_OPERATOR.place)}. Questions about this policy or your data go to ${mail}.`,
      ]],
      ["Two kinds of people", [
        "<strong>Business users</strong> create an account and connect their WhatsApp Business number. <strong>Callers</strong> are the customers of those businesses: people who rang the business and received a WhatsApp reply. For callers' information the business is in charge of how it is used, and MissedCall handles it on the business's behalf.",
      ]],
      ["What we collect", [
        [
          "<strong>Account details:</strong> your name, email address and a hashed password. The password itself is never stored.",
          "<strong>Business details:</strong> business name, industry, phone number, owner name, the services and areas you enter, and team members you invite.",
          "<strong>WhatsApp connection:</strong> your WhatsApp Business Account ID, phone number ID and the access token Meta issues when you connect. The token is stored encrypted.",
          "<strong>Callers' information:</strong> the phone number that called, the WhatsApp messages exchanged with it, and the lead details taken from that conversation (name, area, what they need, how urgent it is).",
          "<strong>Billing:</strong> your plan and subscription status. Card and UPI details are handled by Razorpay and never reach our servers.",
          "<strong>Technical logs:</strong> request times and error details needed to keep the service running. Logs can include a caller's phone number; they do not include message contents or credentials.",
        ],
      ]],
      ["How it is used", [
        [
          "To send the missed-call WhatsApp message and carry on the short conversation that follows.",
          "To show the business its leads and alert the owner on WhatsApp.",
          "To count usage against the plan's monthly allowance and to bill paid plans.",
          "To keep the service secure and to fix faults.",
        ],
        "We do not sell personal information, we do not use it for advertising, and we do not use callers' messages to train AI models.",
      ]],
      ["Who else handles it", [
        "MissedCall relies on a small number of service providers, each of which processes data only to provide its service:",
        [
          "<strong>Meta Platforms (WhatsApp Cloud API)</strong> delivers and receives the WhatsApp messages.",
          "<strong>Vercel</strong> hosts the application.",
          "<strong>Upstash</strong> provides the database the application stores its records in.",
          "<strong>Razorpay</strong> processes subscription payments.",
        ],
        "These providers may process data on servers outside India. We may also disclose information when the law requires it.",
      ]],
      ["How long it is kept", [
        "Leads and conversations stay in a business's account until that business deletes them or closes the account. A business can delete an individual lead from its dashboard at any time. When an account is closed on request, its business details, WhatsApp connection, leads and conversations are deleted within 30 days, except records we are legally required to keep, such as invoices.",
      ]],
      ["Your choices", [
        [
          "<strong>Business users</strong> can correct their details in Settings, delete leads from the dashboard, disconnect by asking us, and ask for the whole account to be deleted.",
          "<strong>Callers</strong> can stop the conversation at any time by not replying, can block the business on WhatsApp, and can ask either the business or us to delete their information.",
        ],
        `How to make a deletion request is set out on the <a href="/data-deletion">data deletion page</a>.`,
      ]],
      ["Security", [
        "Access tokens are encrypted before they are stored, passwords are hashed, each business's records are kept separate from every other business's, and all traffic uses HTTPS. No system is perfectly secure; if a breach affecting your data occurs we will tell the affected businesses without undue delay.",
      ]],
      ["Children", [
        "MissedCall is a tool for businesses and is not intended for use by anyone under 18.",
      ]],
      ["Changes", [
        `If this policy changes in a way that matters, the date at the top changes and we notify account holders. Questions: ${mail}.`,
      ]],
    ]
  );
}

export function termsPage() {
  return legalPage(
    "Terms of Service",
    "These terms apply to anyone who creates a MissedCall account. By creating an account you agree to them.",
    [
      ["The service", [
        `MissedCall is operated by ${escapeHtml(LEGAL_OPERATOR.name)}, ${escapeHtml(LEGAL_OPERATOR.place)}. It sends a WhatsApp message from your business number to people whose calls you missed, holds the conversation that follows, and records the result as a lead in your dashboard.`,
      ]],
      ["Your account", [
        "You must give accurate details, keep your password to yourself, and be authorised to act for the business you register. You are responsible for what happens under your account, including what team members you invite do.",
      ]],
      ["Your WhatsApp number and Meta's rules", [
        [
          "You connect a WhatsApp Business number that you own or are authorised to use.",
          "Messages go out through Meta's WhatsApp Cloud API, so Meta's WhatsApp Business terms and messaging policies apply to you as well as these terms.",
          "Meta decides whether a message template is approved, whether a message is delivered and whether a number stays in good standing. MissedCall cannot override those decisions.",
          "Meta may charge for business-initiated messages. Those charges are between you and Meta and are separate from MissedCall's price.",
        ],
      ]],
      ["Acceptable use", [
        "You may use MissedCall only to respond to people who called your business. You must not use it to send promotional broadcasts, to message people who did not call you, to send unlawful, misleading or abusive content, or to interfere with the service or other customers' data.",
      ]],
      ["Your customers' information", [
        `You decide how your callers' information is used and you are responsible for having a lawful reason to contact them. MissedCall processes that information for you as described in the <a href="/privacy">Privacy Policy</a>.`,
      ]],
      ["Plans and payment", [
        "The Free plan and the Pro plan, with their prices and monthly allowances, are as shown on the pricing section of the website when you subscribe. Pro is billed monthly in advance through Razorpay until you cancel. You can cancel at any time, from Billing in your settings or by emailing us, and keep access until the end of the period already paid for. Payments already made are not refunded except where the law requires it. Any separately agreed setup fee is covered by that agreement, not by these terms.",
      ]],
      ["Availability", [
        "We work to keep MissedCall running but do not promise that it will be uninterrupted or error-free. It depends on your phone reporting missed calls, on Meta's platform and on other providers, any of which can fail. MissedCall does not guarantee that a message will be delivered, that a caller will reply, or any number of leads or sales.",
      ]],
      ["Liability", [
        "To the extent the law allows, MissedCall is provided as is, we are not liable for indirect or consequential loss such as lost profit or lost business, and our total liability for any claim is limited to the amount you paid us for the service in the three months before the claim arose.",
      ]],
      ["Ending the agreement", [
        "You can stop using MissedCall and ask for your account to be deleted at any time. We may suspend or close an account that breaks these terms, that puts the service or other customers at risk, or whose payment has failed, and will tell you when we do.",
      ]],
      ["Changes and governing law", [
        `We may update these terms; if a change matters we will notify account holders before it takes effect. These terms are governed by the laws of India, and the courts at Hyderabad, Telangana have jurisdiction. Questions: ${mail}.`,
      ]],
    ]
  );
}

export function dataDeletionPage() {
  return legalPage(
    "Data Deletion",
    "How to have your information removed from MissedCall, whether you are a business with an account or someone who received a WhatsApp message from a business that uses it.",
    [
      ["If you have a MissedCall account", [
        [
          "<strong>Delete a single lead:</strong> open the lead in your dashboard and choose Delete. It is removed immediately, together with its conversation.",
          `<strong>Delete your whole account:</strong> email ${mail} from the email address on the account with the subject "Delete my MissedCall account".`,
        ],
        "When an account is deleted we remove the business details, team members, WhatsApp connection (including the stored access token), leads and conversations within 30 days. Records we must keep by law, such as invoices, are kept only for as long as that law requires.",
      ]],
      ["If you received a WhatsApp message from a business", [
        `You called a business that uses MissedCall and it replied on WhatsApp. You can ask that business to delete your details, or email ${mail} with the phone number the message was sent to and the name of the business. We will pass the request to the business and delete your number, your messages and the lead made from them within 30 days.`,
        "To stop further messages straight away, block the business's number in WhatsApp.",
      ]],
      ["If you connected with Facebook or WhatsApp and want to disconnect", [
        "You can remove MissedCall's access yourself in your Facebook settings under Business Integrations, or in Meta Business Settings under Integrations. Removing access stops MissedCall sending from your number immediately. To also delete what MissedCall has stored, send the account deletion email described above.",
      ]],
      ["What happens next", [
        `We confirm by email when the deletion is done. If you have not heard back within 7 days, write again to ${mail}.`,
      ]],
    ]
  );
}
