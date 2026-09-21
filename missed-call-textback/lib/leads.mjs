import crypto from "node:crypto";
import { capitalize } from "./text.mjs";

/**
 * Where a lead is in the owner's follow-up, in the order it usually moves.
 * "lost" is terminal but reachable from anywhere — a customer can go cold at
 * any point. Anything not in this list is rejected rather than stored, so a
 * crafted form post can't write arbitrary values onto a lead.
 */
export const LEAD_STATUSES = ["new", "contacted", "in_progress", "completed", "lost"];

export const STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  in_progress: "In progress",
  completed: "Completed",
  lost: "Lost",
};

export function isValidStatus(status) {
  return LEAD_STATUSES.includes(status);
}

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
  const number = lead.callerNumber || "";
  const digits = String(number).replace(/[^\d]/g, "");

  const lines = [
    header,
    "",
    `Name: ${lead.name || "Not given"}`,
    `Phone: ${number || "Not given"}`,
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

  // WhatsApp linkifies tel: and wa.me, so these become tap targets on the
  // owner's phone — the two things he actually does with a lead.
  if (digits) {
    lines.push("", `Call: tel:${number}`, `WhatsApp: https://wa.me/${digits}`);
  }

  return lines.join("\n");
}
