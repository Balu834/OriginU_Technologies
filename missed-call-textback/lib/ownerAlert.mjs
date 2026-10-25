/**
 * Sending a lead alert to the business owner.
 *
 * WhatsApp only delivers free-form text to someone who has messaged the
 * business number in the last 24 hours. A new owner never has, so a plain
 * text alert was accepted by the API and then failed (error 131047), while
 * the dashboard still said the owner had been notified.
 *
 * The alert therefore goes out as the approved `new_lead_alert` template,
 * which has no such window. If the template is not usable yet (Meta has not
 * approved it, or this business connected before it existed), the plain
 * text alert is tried instead: it still works whenever the owner happens to
 * be inside the window, which is no worse than before.
 */
import { capitalize } from "./text.mjs";

export const OWNER_ALERT_TEMPLATE = "new_lead_alert";

/** Template parameters may not be empty, contain newlines, tabs or 4+ spaces. */
function param(value, fallback = "Not given", max = 200) {
  const clean = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const out = clean || fallback;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export function ownerAlertParams(lead, businessName) {
  let need = capitalize(lead.problem) || (lead.eventDate ? "Booking enquiry" : "Service request");
  if (lead.eventDate) need = `${need} on ${lead.eventDate}`;
  else if (lead.urgency) need = `${need} (${lead.urgency})`;
  if (lead.emergency) need = `URGENT: ${need}`;

  return {
    business_name: param(businessName, "your business", 60),
    customer_name: param(lead.name),
    customer_phone: param(lead.callerNumber),
    lead_need: param(need),
    lead_area: param(lead.area),
  };
}

/**
 * Sends the alert, template first. Returns the WhatsApp result plus `via`
 * ("template" or "text") so the caller can record which one went out.
 */
export async function sendOwnerAlert(wa, { to, lead, businessName, language = "en", text }) {
  if (typeof wa.sendTemplate === "function") {
    try {
      const viaTemplate = await wa.sendTemplate(to, OWNER_ALERT_TEMPLATE, language, ownerAlertParams(lead, businessName));
      if (viaTemplate?.ok !== false) return { result: viaTemplate, via: "template" };
    } catch {
      // Fall through to text: an unreachable template must not lose the alert.
    }
  }
  return { result: await wa.sendText(to, text), via: "text" };
}
