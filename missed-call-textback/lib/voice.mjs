/**
 * Turning a business's configuration into the words it actually says.
 *
 * THIS IS NOT AN LLM. There is no model in this system: replies come from
 * the approved strings in templates.json, and lead fields are pulled out
 * by the regex rules in lib/extract.mjs. What this module adds is a small
 * amount of business-specific text composed around those templates, so
 * the `services`, `areas`, `greeting` and `assistantName` a business
 * configures stop being inert records and start appearing in the
 * conversation.
 *
 * Every function returns "" when the business has not configured the
 * thing it describes. That is deliberate: a blank result composes away to
 * nothing and the customer gets exactly the message the product sent
 * before any of this existed, so configuring nothing changes nothing.
 *
 * Two rules these functions exist to keep:
 *
 * 1. Nothing is invented. Only configured values are ever stated. A
 *    business with no services listed never claims to do anything, and no
 *    area is described as covered unless it was entered.
 * 2. Nothing is promised. There are no prices, no availability, no
 *    guarantees and no diagnosis here — those remain the things the
 *    assistant must never say, and composing a sentence is not a licence
 *    to start saying them.
 */

/** At most this many items are listed, so a reply stays one short message. */
const MAX_LISTED = 4;

const clean = (value) => String(value ?? "").trim();

function cleanList(values) {
  return (Array.isArray(values) ? values : []).map(clean).filter(Boolean);
}

/**
 * "A", "A and B", "A, B and C", or "A, B, C and more" once the list is
 * longer than we will read out. "and more" is a statement about the
 * configured list, not a claim about capability.
 */
function joinList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];

  const truncated = items.length > MAX_LISTED;
  const shown = truncated ? items.slice(0, MAX_LISTED) : items;
  const tail = truncated ? "more" : shown.pop();
  return `${shown.join(", ")} and ${tail}`;
}

/**
 * How the business introduces itself, used once per conversation.
 *
 * A configured greeting wins outright — it is the owner's own words. With
 * no greeting but an assistant name, the assistant introduces itself.
 * With neither, this is empty and the conversation opens exactly as it
 * always has.
 */
export function greetingLine(context) {
  const greeting = clean(context?.greeting);
  if (greeting) return greeting;

  const assistant = clean(context?.assistantName);
  const business = clean(context?.name);
  if (assistant && business) return `This is ${assistant} from ${business}.`;
  if (assistant) return `This is ${assistant}.`;

  // Name alone is NOT enough to introduce with. Every business has a
  // name, so greeting on that basis would change the opening line of
  // every conversation already running in production. An introduction is
  // opt-in: configure a greeting or an assistant name, or get the
  // behaviour the product has always had.
  return "";
}

/** What this business actually does, from its own configuration. */
export function servicesLine(context) {
  const services = cleanList(context?.services);
  if (!services.length) return "";
  return `We handle ${joinList(services)}.`;
}

/**
 * Where this business works.
 *
 * Phrased as what is covered, never as a rejection — a customer outside
 * the listed areas is still a lead worth taking, and telling them they
 * are out of range is a decision for the owner, not for a template.
 */
export function areasLine(context) {
  const areas = cleanList(context?.areas);
  if (!areas.length) return "";
  return `We cover ${joinList(areas)}.`;
}

/** Joins the parts that have something to say, dropping the ones that don't. */
export function compose(...parts) {
  return parts.map(clean).filter(Boolean).join(" ");
}

/**
 * The owner's name for message text, preferring the business record over
 * the deployment-wide environment value.
 */
export function ownerNameFor(context, fallback = "") {
  return clean(context?.ownerName) || clean(fallback);
}
