/**
 * Lightweight, rule-based extraction of lead fields from free-text WhatsApp
 * replies. This is deliberately not an LLM call: no extra credential was
 * requested for this MVP, the fields are narrow (name/area/problem/urgency),
 * and a fixed set of regexes is easier to reason about, test, and keep from
 * inventing information than a model call would be.
 *
 * Known limitation: area matching only captures a single word (most
 * Bangalore localities are one word — Whitefield, Indiranagar,
 * Marathahalli). A multi-word area falls back to being asked again.
 */
const NAME_RE = /\b(?:i am|i'?m|this is|my name is|name is|myself)\s+([A-Za-z]{2,20})\b/i;
const AREA_RE = /\b(?:from|in|near|at)\s+([A-Za-z]{2,20})\b/i;
const URGENCY_TODAY_RE = /\b(today|now|asap|right away|immediately|urgent(?:ly)?|emergency)\b/i;
const URGENCY_FLEXIBLE_RE = /\b(tomorrow|later|whenever|any day|no rush|not urgent|next week)\b/i;
const ISSUE_KEYWORDS_RE =
  /\b(ac|a\/c|fan|light|lights|bulb|wiring|wire|wires|switch|switches|socket|sockets|plug|mcb|inverter|geyser|meter|fuse|power|current|breaker|motor|pump|trip|tripping|short circuit|shock|earthing|heater|circuit)\b/i;

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function extractProblem(text) {
  const clauses = text
    .split(/(?:,|\.|;)|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (ISSUE_KEYWORDS_RE.test(clause)) {
      return clause.replace(/^(my|the|our)\s+/i, "").replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

function extractUrgency(text) {
  if (URGENCY_TODAY_RE.test(text)) return "today";
  if (URGENCY_FLEXIBLE_RE.test(text)) return "flexible";
  return null;
}

/** Runs every pattern against the whole message. Returns only fields it found. */
export function extractFields(text) {
  if (typeof text !== "string" || !text.trim()) return {};
  const out = {};

  const nameMatch = text.match(NAME_RE);
  if (nameMatch) out.name = capitalize(nameMatch[1]);

  const areaMatch = text.match(AREA_RE);
  if (areaMatch) out.area = capitalize(areaMatch[1]);

  const problem = extractProblem(text);
  if (problem) out.problem = problem;

  const urgency = extractUrgency(text);
  if (urgency) out.urgency = urgency;

  return out;
}

/**
 * When the bot just asked a direct question (`awaitingField`) and the
 * generic extractor found nothing for it, treat a short leading clause of
 * the reply as the answer — this is what makes "Whitefield" or "Ravi"
 * land in the right slot instead of triggering a re-ask.
 */
export function applyAwaitingFallback(text, awaitingField, found) {
  if (!awaitingField || found[awaitingField] || typeof text !== "string") return found;
  const firstClause = text.split(/[,.]|\band\b/i)[0].trim();
  if (firstClause && firstClause.split(/\s+/).length <= 4) {
    return { ...found, [awaitingField]: awaitingField === "name" ? capitalize(firstClause) : firstClause };
  }
  return found;
}

export const FIELD_ORDER = ["problem", "area", "name", "urgency"];

export function nextMissingField(fields) {
  return FIELD_ORDER.find((f) => !fields[f]) ?? null;
}
