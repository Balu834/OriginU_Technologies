import crypto from "node:crypto";

export function createLead({ callerNumber, fields, emergency }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    callerNumber,
    name: fields.name ?? "",
    area: fields.area ?? "",
    problem: fields.problem ?? "",
    urgency: fields.urgency ?? "",
    summary: buildSummary(fields),
    status: "new",
    source: "missed_call_whatsapp",
    emergency: Boolean(emergency),
    createdAt: now,
    updatedAt: now,
  };
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Two lines, max. Only states what was actually collected — never invents details. */
export function buildSummary({ problem, area, urgency }) {
  const problemPart = capitalize(problem) || "Service request";
  const areaPart = area ? ` in ${area}` : "";
  const urgencyPart =
    urgency === "today"
      ? "customer needs a technician today."
      : urgency
        ? `customer needs a technician (${urgency}).`
        : "customer needs a technician.";
  return `${problemPart}${areaPart}; ${urgencyPart}`;
}

export function formatOwnerNotification(lead) {
  const urgencyDisplay = lead.urgency ? capitalize(lead.urgency) : "Not specified";
  const header = lead.emergency ? "🚨 URGENT — New Lead" : "🔔 New Lead";
  const lines = [
    header,
    "",
    `Name: ${lead.name || "Not given"}`,
    `Area: ${lead.area || "Not given"}`,
    `Problem: ${lead.problem || "Not given"}`,
    `Urgency: ${urgencyDisplay}`,
    "",
    "Summary:",
    lead.summary,
  ];
  if (lead.emergency) {
    lines.push("", "Customer was given basic safety guidance only — no diagnosis given.");
  }
  return lines.join("\n");
}
