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
import { capitalize } from "./text.mjs";

const NAME_RE = /\b(?:i am|i'?m|this is|my name is|name is|myself)\s+([A-Za-z]{2,20})\b/i;
const AREA_RE = /\b(?:from|in|near|at)\s+([A-Za-z]{2,20})\b/i;
// Words that occasionally follow "from"/"in"/"at" as ordinary grammar
// rather than a place ("coming from the switch") — never valid captures.
const STOPWORDS = new Set([
  "the", "a", "an", "my", "our", "this", "that", "is", "are", "was", "were",
  "and", "it", "there", "here", "his", "her", "their", "us", "them",
]);
const URGENCY_TODAY_RE = /\b(today|now|asap|right away|immediately|urgent(?:ly)?|emergency)\b/i;
const URGENCY_FLEXIBLE_RE = /\b(tomorrow|later|whenever|any day|no rush|not urgent|next week)\b/i;
const ISSUE_KEYWORDS_RE =
  /\b(ac|a\/c|fan|light|lights|bulb|wiring|wire|wires|switch|switches|socket|sockets|plug|mcb|inverter|geyser|meter|fuse|power|current|breaker|motor|pump|trip|tripping|short circuit|shock|earthing|heater|circuit)\b/i;

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

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// "12 Dec", "12th December 2026", "Dec 12", "12/12", "12-12-2026", "next
// month", "this Sunday". Only what the customer wrote is kept; nothing is
// turned into a calendar date, so a vague answer stays vague rather than
// becoming a wrong exact one.
const DATE_RE = new RegExp(
  [
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b(?:,?\\s+\\d{4})?`,
    `\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`,
    `\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b`,
    `\\b(?:this|next|coming)\\s+(?:week|month|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`,
  ].join("|"),
  "i"
);

function extractDate(text) {
  const m = text.match(DATE_RE);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
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
  if (nameMatch && !STOPWORDS.has(nameMatch[1].toLowerCase())) out.name = capitalize(nameMatch[1]);

  const areaMatch = text.match(AREA_RE);
  if (areaMatch && !STOPWORDS.has(areaMatch[1].toLowerCase())) out.area = capitalize(areaMatch[1]);

  const problem = extractProblem(text);
  if (problem) out.problem = problem;

  const urgency = extractUrgency(text);
  if (urgency) out.urgency = urgency;

  const date = extractDate(text);
  if (date) out.date = date;

  return out;
}

// How many words a direct answer may have before it stops looking like an
// answer. A problem is a sentence ("kitchen tap is leaking badly"); a name
// or an area is a couple of words.
const MAX_ANSWER_WORDS = { problem: 15, date: 6, area: 4, name: 4, urgency: 4 };

/**
 * When the bot just asked a direct question (`awaitingField`) and the
 * generic extractor found nothing for it, treat a short leading clause of
 * the reply as the answer — this is what makes "Whitefield" or "Ravi"
 * land in the right slot instead of triggering a re-ask.
 */
// A greeting is a hello, not an answer to "what do you need?".
const GREETING_RE = /^\s*(?:hi+|hello+|hey+|hii+|helo|hlo|namaste|namaskar|good\s+(?:morning|afternoon|evening)|yes|yeah|ok(?:ay)?|sir|madam|anna|bhai)(?:[\s!.,]+(?:hi+|hello+|there|sir|madam|anna|bhai|ji))*[\s!.?]*$/i;

export function applyAwaitingFallback(text, awaitingField, found) {
  if (!awaitingField || typeof text !== "string") return found;
  if (GREETING_RE.test(text)) return found;
  // A problem keeps "and" ("makeup and hair"); short answers split on it.
  const clauses = (awaitingField === "problem" ? text.split(/[,.;\n]/) : text.split(/[,.;\n]|\band\b/i))
    .map((s) => s.trim())
    .filter(Boolean);
  const out = { ...found };

  if (!out[awaitingField]) {
    const firstClause = clauses[0] ?? "";
    const limit = MAX_ANSWER_WORDS[awaitingField] ?? 4;
    if (!firstClause || firstClause.split(/\s+/).length > limit || STOPWORDS.has(firstClause.toLowerCase())) {
      return found;
    }
    out[awaitingField] = awaitingField === "name" || awaitingField === "area" ? capitalize(firstClause) : firstClause;
  }

  // The missed-call template asks for "what you need and your area", so
  // "AC not cooling, Kukatpally" is the common first reply: a short second
  // clause after the problem is the area.
  if (awaitingField === "problem" && !out.area && clauses.length === 2) {
    const second = clauses[1].replace(/^(?:in|at|near|from)\s+/i, "");
    if (second.split(/\s+/).length <= 3 && !STOPWORDS.has(second.toLowerCase()) && !DATE_RE.test(second)) {
      out.area = capitalize(second);
    }
  }
  return out;
}

export const FIELD_ORDER = ["problem", "area", "name", "urgency"];

export function nextMissingField(fields, order = FIELD_ORDER) {
  return order.find((f) => !fields[f]) ?? null;
}
